//! Display geometry derived from a validated map package: simplified polylines per level of
//! detail, indexed by a fixed tile grid. For drawing only, never for control.
//!
//! Coordinates stay in the package's world space (X east, Z south, world units; the physical
//! unit is unconfirmed). No transformation is applied. Curves are the package's **estimated**
//! cubic Hermite curves (model `hermite_stored_length`, RoadPilot-Map
//! `docs/formats/map-package.md`), evaluated here from the node positions, the node travel
//! directions and the stored tangent scale; roads without a curve are drawn as the straight line
//! between their nodes and flagged.

use roadpilot_map_package::{CurveRecord, GeometryData, LanesRecord, NodeRecord};
use std::collections::HashMap;

/// Road classes, most important first. Derived from the lane types of the road look, which
/// differ between the games (ATS `freeway`/`divided`, ETS2 `motorway`/`expressway`). An unknown
/// lane type counts as a local road. This is a display heuristic, not a road category of the
/// game.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd, Hash)]
#[repr(u8)]
pub enum RoadClass {
    Motorway = 0,
    Primary = 1,
    Local = 2,
    /// Lanes without vehicle traffic (paths, dirt tracks, yards) or without lane data.
    Minor = 3,
    /// Rail and tram tracks stored as roads.
    Rail = 4,
}

/// The road has an estimated curve (always true unless `CHORD`).
pub const FLAG_ESTIMATED: u8 = 1;
/// No curve was available: drawn as the straight line between the two nodes.
pub const FLAG_CHORD: u8 = 2;
/// The estimated curve does not reproduce the stored road length (known model failure).
pub const FLAG_LENGTH_INCONSISTENT: u8 = 4;

pub fn classify(lanes: &LanesRecord) -> RoadClass {
    let LanesRecord::Resolved(items) = lanes else {
        return RoadClass::Minor;
    };
    let mut best: Option<RoadClass> = None;
    let mut rail = false;
    for lane in items {
        let t = lane.lane_type.as_str();
        let class = if t.starts_with("traffic_lane.rail") {
            rail = true;
            continue;
        } else if t.starts_with("traffic_lane.road.freeway")
            || t.starts_with("traffic_lane.road.motorway")
        {
            RoadClass::Motorway
        } else if t.starts_with("traffic_lane.road.divided")
            || t.starts_with("traffic_lane.road.expressway")
        {
            RoadClass::Primary
        } else if t.starts_with("traffic_lane.no_vehicles") {
            RoadClass::Minor
        } else {
            RoadClass::Local
        };
        best = Some(best.map_or(class, |b| b.min(class)));
    }
    best.unwrap_or(if rail {
        RoadClass::Rail
    } else {
        RoadClass::Minor
    })
}

/// One level of detail.
#[derive(Clone, Copy, Debug)]
pub struct LevelSpec {
    /// Edge length of a tile, world units.
    pub tile_size: f64,
    /// Douglas-Peucker tolerance, world units.
    pub tolerance: f64,
    /// The least important class shown.
    pub max_class: RoadClass,
}

/// Level 0 is the most detailed. The frontend picks a level from its zoom.
pub const LEVELS: [LevelSpec; 4] = [
    LevelSpec {
        tile_size: 1024.0,
        tolerance: 0.5,
        max_class: RoadClass::Rail,
    },
    LevelSpec {
        tile_size: 4096.0,
        tolerance: 4.0,
        max_class: RoadClass::Local,
    },
    LevelSpec {
        tile_size: 16384.0,
        tolerance: 32.0,
        max_class: RoadClass::Primary,
    },
    LevelSpec {
        tile_size: 65536.0,
        tolerance: 160.0,
        max_class: RoadClass::Motorway,
    },
];

/// Sampling step of the curves before simplification, world units.
const SAMPLE_STEP: f64 = 2.0;
const MAX_SAMPLES: usize = 2048;
/// A road spanning more tiles than this in one level is not indexed (corrupt bounds).
const MAX_TILES_PER_ROAD: i64 = 4096;

#[derive(Debug)]
pub struct DisplayRoad {
    /// Position of the road in the package's road order.
    pub index: u32,
    pub class: RoadClass,
    pub flags: u8,
    /// Absolute world coordinates `[x, z]`; `f32` is accurate to about 1 cm at 100 km.
    pub points: Box<[[f32; 2]]>,
}

#[derive(Debug)]
pub struct DisplayLevel {
    pub spec: LevelSpec,
    pub roads: Vec<DisplayRoad>,
    /// Roads per tile, most important first.
    pub tiles: HashMap<(i32, i32), Vec<u32>>,
    pub points: usize,
}

#[derive(Debug)]
pub struct DisplayMap {
    pub levels: Vec<DisplayLevel>,
    /// Roads that could not be drawn (non-finite geometry, missing nodes).
    pub skipped: u32,
}

impl DisplayMap {
    /// Heap memory held by the display data (capacities, an estimate of the allocation).
    #[cfg(test)]
    pub fn heap_bytes(&self) -> usize {
        self.levels
            .iter()
            .map(|l| {
                l.roads.capacity() * std::mem::size_of::<DisplayRoad>()
                    + l.points * std::mem::size_of::<[f32; 2]>()
                    + l.tiles.capacity() * (std::mem::size_of::<((i32, i32), Vec<u32>)>() + 8)
                    + l.tiles.values().map(|v| v.capacity() * 4).sum::<usize>()
            })
            .sum()
    }
}

/// Travel direction at a node: local -Z rotated by the unit quaternion (w, x, y, z).
fn forward(rotation: [f32; 4]) -> [f64; 3] {
    let [w, x, y, z] = rotation.map(f64::from);
    let v = [0.0, 0.0, -1.0];
    let t = [
        2.0 * (y * v[2] - z * v[1]),
        2.0 * (z * v[0] - x * v[2]),
        2.0 * (x * v[1] - y * v[0]),
    ];
    [
        v[0] + w * t[0] + (y * t[2] - z * t[1]),
        v[1] + w * t[1] + (z * t[0] - x * t[2]),
        v[2] + w * t[2] + (x * t[1] - y * t[0]),
    ]
}

fn position(node: &NodeRecord) -> [f64; 3] {
    node.position.map(|p| f64::from(p) / 256.0)
}

/// Points of the estimated curve, horizontal plane, about every `SAMPLE_STEP` units.
fn hermite(
    p0: [f64; 3],
    p1: [f64; 3],
    d0: [f64; 3],
    d1: [f64; 3],
    l: f64,
    length: f64,
) -> Vec<[f64; 2]> {
    let n = ((length / SAMPLE_STEP).ceil() as usize).clamp(1, MAX_SAMPLES);
    (0..=n)
        .map(|i| {
            let t = i as f64 / n as f64;
            let (t2, t3) = (t * t, t * t * t);
            let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
            let h10 = t3 - 2.0 * t2 + t;
            let h01 = -2.0 * t3 + 3.0 * t2;
            let h11 = t3 - t2;
            let at = |k: usize| h00 * p0[k] + h10 * l * d0[k] + h01 * p1[k] + h11 * l * d1[k];
            [at(0), at(2)]
        })
        .collect()
}

/// Douglas-Peucker without recursion. Keeps the first and last point.
pub fn simplify(points: &[[f64; 2]], tolerance: f64) -> Vec<[f64; 2]> {
    if points.len() <= 2 {
        return points.to_vec();
    }
    let mut keep = vec![false; points.len()];
    keep[0] = true;
    keep[points.len() - 1] = true;
    let mut stack = vec![(0usize, points.len() - 1)];
    while let Some((a, b)) = stack.pop() {
        let (pa, pb) = (points[a], points[b]);
        let (dx, dz) = (pb[0] - pa[0], pb[1] - pa[1]);
        let len = dx.hypot(dz);
        let mut far = (0.0, a);
        for (i, p) in points.iter().enumerate().take(b).skip(a + 1) {
            let d = if len == 0.0 {
                (p[0] - pa[0]).hypot(p[1] - pa[1])
            } else {
                ((p[0] - pa[0]) * dz - (p[1] - pa[1]) * dx).abs() / len
            };
            if d > far.0 {
                far = (d, i);
            }
        }
        if far.0 > tolerance {
            keep[far.1] = true;
            stack.push((a, far.1));
            stack.push((far.1, b));
        }
    }
    points
        .iter()
        .zip(keep)
        .filter_map(|(p, k)| k.then_some(*p))
        .collect()
}

fn tile_range(min: f64, max: f64, size: f64) -> (i32, i32) {
    ((min / size).floor() as i32, (max / size).floor() as i32)
}

/// Builds the display data. Roads with missing nodes or non-finite geometry are skipped and
/// counted; they are never drawn with made-up geometry.
pub fn build(data: &GeometryData) -> DisplayMap {
    let node = |id: u64| {
        data.nodes
            .binary_search_by_key(&id, |n| n.id)
            .ok()
            .map(|i| &data.nodes[i])
    };
    let mut levels: Vec<DisplayLevel> = LEVELS
        .iter()
        .map(|spec| DisplayLevel {
            spec: *spec,
            roads: Vec::new(),
            tiles: HashMap::new(),
            points: 0,
        })
        .collect();
    let mut skipped = 0u32;

    for (index, road) in data.roads.iter().enumerate() {
        let (Some(start), Some(end)) = (node(road.start), node(road.end)) else {
            skipped += 1;
            continue;
        };
        let (p0, p1) = (position(start), position(end));
        let (dense, flags) = match &road.curve {
            CurveRecord::Estimated {
                tangent_scale,
                estimated_length,
                length_consistent,
                ..
            } => (
                hermite(
                    p0,
                    p1,
                    forward(start.rotation),
                    forward(end.rotation),
                    *tangent_scale,
                    *estimated_length,
                ),
                FLAG_ESTIMATED
                    | if *length_consistent {
                        0
                    } else {
                        FLAG_LENGTH_INCONSISTENT
                    },
            ),
            CurveRecord::Unavailable(_) => (vec![[p0[0], p0[2]], [p1[0], p1[2]]], FLAG_CHORD),
        };
        if dense.iter().flatten().any(|v| !v.is_finite()) {
            skipped += 1;
            continue;
        }
        let class = classify(&road.lanes);
        for level in &mut levels {
            if class > level.spec.max_class {
                continue;
            }
            let simplified = simplify(&dense, level.spec.tolerance);
            let (mut min_x, mut min_z, mut max_x, mut max_z) =
                (f64::MAX, f64::MAX, f64::MIN, f64::MIN);
            for p in &simplified {
                min_x = min_x.min(p[0]);
                max_x = max_x.max(p[0]);
                min_z = min_z.min(p[1]);
                max_z = max_z.max(p[1]);
            }
            let size = level.spec.tile_size;
            let (x0, x1) = tile_range(min_x, max_x, size);
            let (z0, z1) = tile_range(min_z, max_z, size);
            if (i64::from(x1) - i64::from(x0) + 1) * (i64::from(z1) - i64::from(z0) + 1)
                > MAX_TILES_PER_ROAD
            {
                continue;
            }
            let id = level.roads.len() as u32;
            level.points += simplified.len();
            level.roads.push(DisplayRoad {
                index: index as u32,
                class,
                flags,
                points: simplified
                    .iter()
                    .map(|p| [p[0] as f32, p[1] as f32])
                    .collect(),
            });
            for tx in x0..=x1 {
                for tz in z0..=z1 {
                    level.tiles.entry((tx, tz)).or_default().push(id);
                }
            }
        }
    }
    // Most important roads first in every tile, so a size limit drops minor roads first.
    for level in &mut levels {
        let roads = &level.roads;
        for ids in level.tiles.values_mut() {
            ids.sort_by_key(|id| (roads[*id as usize].class, *id));
            ids.shrink_to_fit();
        }
    }
    DisplayMap { levels, skipped }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::testkit::{Road, TestPackage};
    use roadpilot_map_package::{LaneRecord, MapPackage, Quality, Side};
    use std::f64::consts::FRAC_PI_2;

    fn lanes(types: &[&str]) -> LanesRecord {
        LanesRecord::Resolved(
            types
                .iter()
                .enumerate()
                .map(|(i, t)| LaneRecord {
                    side: Side::Right,
                    index: i as u16,
                    lane_type: (*t).into(),
                    type_certain: true,
                    direction: None,
                    offset: None,
                    geometry: Quality::Unavailable,
                })
                .collect(),
        )
    }

    #[test]
    fn classifies_both_games_lane_types() {
        use RoadClass::*;
        let cases: [(&[&str], RoadClass); 9] = [
            (&["traffic_lane.road.freeway"], Motorway),
            (&["traffic_lane.road.motorway.low_density"], Motorway),
            (&["traffic_lane.road.divided"], Primary),
            (&["traffic_lane.road.expressway"], Primary),
            (
                &["traffic_lane.road.local", "traffic_lane.road.freeway"],
                Motorway,
            ),
            (&["traffic_lane.no_vehicles.dirt"], Minor),
            (&["traffic_lane.rail.train.cargo"], Rail),
            (
                &["traffic_lane.rail.tram", "traffic_lane.road.local.tram"],
                Local,
            ),
            (&["something.new"], Local),
        ];
        for (types, class) in cases {
            assert_eq!(classify(&lanes(types)), class, "{types:?}");
        }
        assert_eq!(classify(&lanes(&[])), Minor);
        assert_eq!(
            classify(&LanesRecord::Unresolved("no_lane_data".into())),
            Minor
        );
    }

    #[test]
    fn simplification_keeps_the_ends_and_respects_the_tolerance() {
        let line: Vec<[f64; 2]> = (0..=100).map(|i| [f64::from(i), 0.0]).collect();
        assert_eq!(simplify(&line, 0.1), vec![[0.0, 0.0], [100.0, 0.0]]);
        let arc: Vec<[f64; 2]> = (0..=90)
            .map(|d| {
                let a = f64::from(d).to_radians();
                [100.0 * a.cos(), 100.0 * a.sin()]
            })
            .collect();
        for tol in [0.5, 4.0, 32.0] {
            let s = simplify(&arc, tol);
            assert_eq!(s.first(), arc.first());
            assert_eq!(s.last(), arc.last());
            // Every original point lies within the tolerance of the simplified line.
            for p in &arc {
                let d = s
                    .windows(2)
                    .map(|w| seg_dist(*p, w[0], w[1]))
                    .fold(f64::MAX, f64::min);
                assert!(d <= tol + 1e-9, "{d} > {tol}");
            }
        }
        assert!(simplify(&arc, 32.0).len() < simplify(&arc, 0.5).len());
        assert_eq!(simplify(&[[1.0, 1.0]], 1.0), vec![[1.0, 1.0]]);
    }

    fn seg_dist(p: [f64; 2], a: [f64; 2], b: [f64; 2]) -> f64 {
        let (dx, dz) = (b[0] - a[0], b[1] - a[1]);
        let ll = dx * dx + dz * dz;
        let t = if ll == 0.0 {
            0.0
        } else {
            (((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / ll).clamp(0.0, 1.0)
        };
        (p[0] - a[0] - t * dx).hypot(p[1] - a[1] - t * dz)
    }

    fn display(pkg: &crate::map::testkit::WrittenPackage) -> DisplayMap {
        build(MapPackage::open(pkg.dir()).unwrap().data())
    }

    #[test]
    fn follows_the_estimated_curve_through_the_node_directions() {
        // Quarter turn: east at the start, south (+z) at the end.
        let pkg = TestPackage::new("ats")
            .road(
                Road::straight(1, (0.0, 0.0), (100.0, 100.0), "traffic_lane.road.local")
                    .bend(0.0, FRAC_PI_2),
            )
            .write();
        let d = display(&pkg);
        let road = &d.levels[0].roads[0];
        assert_eq!(road.points.first(), Some(&[0.0, 0.0]));
        assert_eq!(road.points.last(), Some(&[100.0, 100.0]));
        assert!(road.points.len() > 4, "a curve, not a chord");
        // The curve leaves eastwards: the second point lies east of the start, near z = 0.
        let [x, z] = road.points[1];
        assert!(x > 0.0 && z < x, "{x} {z}");
        assert_eq!(road.flags, FLAG_ESTIMATED);
    }

    #[test]
    fn keeps_world_coordinates_unchanged() {
        let pkg = TestPackage::new("ets2")
            .road(Road::straight(
                1,
                (-98_752.5, -68_558.25),
                (-98_652.5, -68_558.25),
                "traffic_lane.road.local",
            ))
            .write();
        let r = &display(&pkg).levels[0].roads[0];
        assert_eq!(
            &*r.points,
            &[[-98_752.5, -68_558.25], [-98_652.5, -68_558.25]]
        );
    }

    #[test]
    fn flags_chords_and_inconsistent_curves() {
        let pkg = TestPackage::new("ats")
            .road(Road::straight(1, (0.0, 0.0), (50.0, 0.0), "x").without_curve())
            .road(Road::straight(2, (0.0, 10.0), (50.0, 10.0), "x").length_inconsistent())
            .write();
        let d = display(&pkg);
        let flags: Vec<u8> = d.levels[0].roads.iter().map(|r| r.flags).collect();
        assert_eq!(
            flags,
            vec![FLAG_CHORD, FLAG_ESTIMATED | FLAG_LENGTH_INCONSISTENT]
        );
    }

    #[test]
    fn shows_fewer_classes_on_coarser_levels() {
        let pkg = TestPackage::new("ets2")
            .road(Road::straight(
                1,
                (0.0, 0.0),
                (500.0, 0.0),
                "traffic_lane.road.motorway",
            ))
            .road(Road::straight(
                2,
                (0.0, 50.0),
                (500.0, 50.0),
                "traffic_lane.road.expressway",
            ))
            .road(Road::straight(
                3,
                (0.0, 100.0),
                (500.0, 100.0),
                "traffic_lane.road.local",
            ))
            .road(Road::straight(
                4,
                (0.0, 150.0),
                (500.0, 150.0),
                "traffic_lane.no_vehicles",
            ))
            .road(Road::straight(
                5,
                (0.0, 200.0),
                (500.0, 200.0),
                "traffic_lane.rail.train",
            ))
            .write();
        let d = display(&pkg);
        let counts: Vec<usize> = d.levels.iter().map(|l| l.roads.len()).collect();
        assert_eq!(counts, vec![5, 3, 2, 1]);
        assert_eq!(d.levels[3].roads[0].class, RoadClass::Motorway);
    }

    #[test]
    fn indexes_roads_in_every_tile_they_cross_most_important_first() {
        let pkg = TestPackage::new("ats")
            .road(Road::straight(
                1,
                (1000.0, 10.0),
                (1100.0, 10.0),
                "traffic_lane.road.local",
            ))
            .road(Road::straight(
                2,
                (900.0, 20.0),
                (2100.0, 20.0),
                "traffic_lane.road.freeway",
            ))
            .road(Road::straight(
                3,
                (-10.0, -10.0),
                (-5.0, -5.0),
                "traffic_lane.road.local",
            ))
            .write();
        let l0 = &display(&pkg).levels[0];
        let tiles: Vec<(i32, i32)> = {
            let mut t: Vec<_> = l0.tiles.keys().copied().collect();
            t.sort();
            t
        };
        assert_eq!(tiles, vec![(-1, -1), (0, 0), (1, 0), (2, 0)]);
        let first = &l0.roads[l0.tiles[&(0, 0)][0] as usize];
        assert_eq!(
            first.class,
            RoadClass::Motorway,
            "freeway listed before the local road"
        );
        assert_eq!(l0.tiles[&(1, 0)].len(), 2);
        assert_eq!(l0.tiles[&(2, 0)].len(), 1);
    }

    #[test]
    fn indexes_a_large_synthetic_network_completely() {
        // A 60 × 60 grid of 500-unit roads, bent, over 30 × 30 km: 7,200 roads.
        let mut roads = Vec::new();
        let mut id = 1;
        for i in 0..60 {
            for j in 0..60 {
                let (x, z) = (
                    f64::from(i) * 500.0 - 15_000.0,
                    f64::from(j) * 500.0 - 15_000.0,
                );
                let class = if j % 10 == 0 {
                    "traffic_lane.road.motorway"
                } else {
                    "traffic_lane.road.local"
                };
                roads.push(Road::straight(id, (x, z), (x + 500.0, z), class).bend(0.2, -0.2));
                roads.push(Road::straight(id + 1, (x, z), (x, z + 500.0), class).bend(1.7, 1.4));
                id += 2;
            }
        }
        let pkg = TestPackage::new("ets2").roads(roads).write();
        let d = display(&pkg);
        assert_eq!(d.skipped, 0);
        assert_eq!(d.levels[0].roads.len(), 7200);
        // Every road is reachable through the tiles of the most detailed level.
        let mut seen = vec![false; 7200];
        for ids in d.levels[0].tiles.values() {
            for id in ids {
                seen[d.levels[0].roads[*id as usize].index as usize] = true;
            }
        }
        assert!(seen.iter().all(|s| *s));
        // Coarser levels hold fewer roads and fewer points.
        let points: Vec<usize> = d.levels.iter().map(|l| l.points).collect();
        assert!(points.windows(2).all(|w| w[0] > w[1]), "{points:?}");
        // Every tile stays well inside the response limit.
        for (level, l) in d.levels.iter().enumerate() {
            for (x, z) in l.tiles.keys() {
                let bytes = crate::map::tiles::encode(&d, 1, level as u8, *x, *z);
                assert!(bytes.len() < 1_400_000);
            }
        }
    }

    #[test]
    fn skips_roads_with_missing_nodes() {
        let pkg = TestPackage::new("ats")
            .road(Road::straight(1, (0.0, 0.0), (10.0, 0.0), "x"))
            .write();
        let mut data = MapPackage::open(pkg.dir()).unwrap().data().clone();
        data.nodes.clear();
        let d = build(&data);
        assert_eq!(d.skipped, 1);
        assert!(d.levels.iter().all(|l| l.roads.is_empty()));
    }
}
