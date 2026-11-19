//! Synthetic map packages for tests, written with the RoadPilot-Map writer into a temporary
//! folder that is removed again. No game data is involved.
//!
//! Each test uses only some of the builder options.
#![allow(dead_code)]

use roadpilot_map_package::{
    Counts, CurveRecord, DEFAULT_SPATIAL_CELL_SIZE, FileEntry, GeometryCounts, LaneDirectionRecord,
    LaneRecord, LanesRecord, LinkRecord, Manifest, NodeRecord, Quality, RoadRecord, Side,
    TrafficSideRecord, checksum, write_geometry,
};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT: AtomicU64 = AtomicU64::new(0);

/// A road between two points (world units, x east / z south). Straight unless `bend` is set.
#[derive(Clone, Debug)]
pub struct Road {
    pub id: u64,
    pub from: (f64, f64),
    pub to: (f64, f64),
    pub lane_types: Vec<String>,
    /// Travel directions at the start and end (radians from +x towards +z); `None` = chord.
    pub bend: Option<(f64, f64)>,
    pub curve_unavailable: bool,
    pub length_inconsistent: bool,
}

impl Road {
    pub fn straight(id: u64, from: (f64, f64), to: (f64, f64), lane_type: &str) -> Self {
        Self {
            id,
            from,
            to,
            lane_types: vec![lane_type.to_owned()],
            bend: None,
            curve_unavailable: false,
            length_inconsistent: false,
        }
    }

    pub fn lanes(mut self, types: &[&str]) -> Self {
        self.lane_types = types.iter().map(|t| (*t).to_owned()).collect();
        self
    }

    pub fn bend(mut self, start: f64, end: f64) -> Self {
        self.bend = Some((start, end));
        self
    }

    pub fn without_curve(mut self) -> Self {
        self.curve_unavailable = true;
        self
    }

    pub fn length_inconsistent(mut self) -> Self {
        self.length_inconsistent = true;
        self
    }
}

/// Quaternion (w, x, y, z) that turns local -Z into the horizontal direction `angle`
/// (radians from +x towards +z).
fn rotation_towards(angle: f64) -> [f32; 4] {
    let (dx, dz) = (angle.cos(), angle.sin());
    // A rotation by theta about +Y maps (0, 0, -1) to (-sin theta, 0, -cos theta).
    let theta = (-dx).atan2(-dz);
    [
        (theta / 2.0).cos() as f32,
        0.0,
        (theta / 2.0).sin() as f32,
        0.0,
    ]
}

/// The node at `p`, created with travel direction `angle` if it does not exist yet, so roads
/// that meet share a node.
fn node_for(
    nodes: &mut BTreeMap<u64, NodeRecord>,
    by_pos: &mut BTreeMap<(i64, i64), u64>,
    p: (f64, f64),
    angle: f64,
) -> u64 {
    let key = ((p.0 * 256.0).round() as i64, (p.1 * 256.0).round() as i64);
    if let Some(id) = by_pos.get(&key) {
        return *id;
    }
    let id = 0x1000 + by_pos.len() as u64;
    by_pos.insert(key, id);
    nodes.insert(
        id,
        NodeRecord {
            id,
            position: [key.0 as i32, 0, key.1 as i32],
            rotation: rotation_towards(angle),
            backward: LinkRecord::None,
            forward: LinkRecord::None,
        },
    );
    id
}

pub struct TestPackage {
    game: String,
    roads: Vec<Road>,
    schema_major: u32,
    without_footer: bool,
}

pub struct WrittenPackage {
    dir: PathBuf,
    content_id: u64,
}

impl WrittenPackage {
    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn content_id(&self) -> u64 {
        self.content_id
    }
}

impl Drop for WrittenPackage {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl TestPackage {
    pub fn new(game: &str) -> Self {
        Self {
            game: game.to_owned(),
            roads: Vec::new(),
            schema_major: 1,
            without_footer: false,
        }
    }

    pub fn road(mut self, road: Road) -> Self {
        self.roads.push(road);
        self
    }

    pub fn roads(mut self, roads: impl IntoIterator<Item = Road>) -> Self {
        self.roads.extend(roads);
        self
    }

    pub fn schema_major(mut self, major: u32) -> Self {
        self.schema_major = major;
        self
    }

    /// Writes a geometry file without its footer, with a manifest that matches those bytes,
    /// so only the reader's own completeness check can find it.
    pub fn without_footer(mut self) -> Self {
        self.without_footer = true;
        self
    }

    pub fn write(self) -> WrittenPackage {
        let dir = std::env::temp_dir().join(format!(
            "roadpilot-map-pkg-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();

        // Nodes keyed by position, so roads that meet share a node.
        let mut nodes: BTreeMap<u64, NodeRecord> = BTreeMap::new();
        let mut by_pos: BTreeMap<(i64, i64), u64> = BTreeMap::new();
        let mut roads = Vec::new();
        let mut lanes = 0u64;
        for r in &self.roads {
            let (dx, dz) = (r.to.0 - r.from.0, r.to.1 - r.from.1);
            let chord = dx.hypot(dz);
            let (a0, a1) = r.bend.unwrap_or((dz.atan2(dx), dz.atan2(dx)));
            let start = node_for(&mut nodes, &mut by_pos, r.from, a0);
            let end = node_for(&mut nodes, &mut by_pos, r.to, a1);
            nodes.get_mut(&start).unwrap().forward = LinkRecord::Road(r.id);
            nodes.get_mut(&end).unwrap().backward = LinkRecord::Road(r.id);
            let curve = if r.curve_unavailable {
                CurveRecord::Unavailable("no_geometry".into())
            } else {
                // A box around the control polygon contains the Hermite curve.
                let (p0, p1) = (r.from, r.to);
                let c0 = (p0.0 + chord * a0.cos() / 3.0, p0.1 + chord * a0.sin() / 3.0);
                let c1 = (p1.0 - chord * a1.cos() / 3.0, p1.1 - chord * a1.sin() / 3.0);
                let xs = [p0.0, p1.0, c0.0, c1.0];
                let zs = [p0.1, p1.1, c0.1, c1.1];
                let min = |v: [f64; 4]| v.into_iter().fold(f64::MAX, f64::min) - 1.0;
                let max = |v: [f64; 4]| v.into_iter().fold(f64::MIN, f64::max) + 1.0;
                let deviation = if r.length_inconsistent { 0.05 } else { 0.0 };
                CurveRecord::Estimated {
                    tangent_scale: chord,
                    estimated_length: chord,
                    length_deviation: deviation,
                    length_consistent: !r.length_inconsistent,
                    bounds: [min(xs), -1.0, min(zs), max(xs), 1.0, max(zs)],
                }
            };
            let items: Vec<LaneRecord> = r
                .lane_types
                .iter()
                .enumerate()
                .map(|(i, t)| LaneRecord {
                    side: Side::Right,
                    index: i as u16,
                    lane_type: t.clone(),
                    type_certain: true,
                    direction: Some(LaneDirectionRecord::Forward),
                    offset: None,
                    geometry: Quality::Unavailable,
                })
                .collect();
            lanes += items.len() as u64;
            roads.push(RoadRecord {
                id: r.id,
                start,
                end,
                look: "road.test".into(),
                stored_length: chord as f32,
                traffic_side: TrafficSideRecord::Right,
                lanes: LanesRecord::Resolved(items),
                curve,
            });
        }
        roads.sort_by_key(|r| r.id);

        let counts = GeometryCounts {
            nodes: nodes.len() as u64,
            roads: roads.len() as u64,
            junctions: 0,
            connections: 0,
        };
        let mut bytes = Vec::new();
        let written = write_geometry(
            &mut bytes,
            counts,
            nodes.into_values(),
            roads,
            Vec::new(),
            Vec::new(),
        )
        .unwrap();
        if self.without_footer {
            // Drop the last line (the footer).
            let end = bytes.len() - 1;
            let cut = bytes[..end].iter().rposition(|b| *b == b'\n').unwrap() + 1;
            bytes.truncate(cut);
        }
        std::fs::write(dir.join("geometry.jsonl"), &bytes).unwrap();

        let manifest = Manifest {
            schema_major: 1,
            schema_minor: 0,
            content_revision: 1,
            generator_name: "roadpilot-test".into(),
            generator_version: "0".into(),
            game: self.game,
            map: None,
            game_version: None,
            archives: None,
            counts: Counts {
                nodes: written.counts.nodes,
                roads: written.counts.roads,
                lanes,
                junctions: 0,
                connections: 0,
            },
            curve_model: "hermite_stored_length".into(),
            length_tolerance: 0.001,
            spatial_cell_size: DEFAULT_SPATIAL_CELL_SIZE,
            limitations: vec!["road_curve_is_estimated".into()],
            files: vec![FileEntry {
                name: "geometry.jsonl".into(),
                role: "geometry".into(),
                format: "roadpilot-map-geometry".into(),
                schema_major: 1,
                schema_minor: 0,
                bytes: bytes.len() as u64,
                checksum: checksum(&bytes),
            }],
        };
        let content_id = manifest.content_id();
        let mut json = manifest.to_json().unwrap();
        if self.schema_major != 1 {
            // The writer refuses other versions; a reader must still recognise them.
            json = json.replacen(
                "\"schema_version\":{\"major\":1,",
                &format!("\"schema_version\":{{\"major\":{},", self.schema_major),
                1,
            );
        }
        std::fs::write(dir.join("manifest.json"), json).unwrap();
        WrittenPackage { dir, content_id }
    }
}
