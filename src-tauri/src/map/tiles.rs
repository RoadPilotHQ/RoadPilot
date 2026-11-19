//! Binary map tiles for the dashboard (command `map_tile`), and their in-memory cache.
//!
//! The WebView never receives the package: only the roads of the requested tile, simplified
//! for its level. Format version 1, little endian, every section 4-byte aligned so the points
//! can be read as a `Float32Array` without copying:
//!
//! ```text
//! offset size  field
//!      0    4  magic "RPMT"
//!      4    2  format version (1)
//!      6    1  level of detail (0 = most detailed)
//!      7    1  flags (bit 0: truncated, the tile hit its size limit)
//!      8    4  tile x (i32)            tile covers [x·size, (x+1)·size) × [z·size, (z+1)·size)
//!     12    4  tile z (i32)
//!     16    4  tile size (f32, world units)
//!     20    4  reserved (0)
//!     24    8  origin x (f64) = x·size
//!     32    8  origin z (f64) = z·size
//!     40    4  road count R (u32)
//!     44    4  point count P (u32)
//!     48    8  package content id (u64)
//!     56 12·R  roads: package road index u32, first point u32, point count u16,
//!              class u8 (0 motorway … 4 rail), flags u8 (1 estimated, 2 chord, 4 length off)
//!      … 8·P  points: x, z (f32) relative to the origin; a road may extend beyond its tile
//! ```

use super::display::{DisplayMap, LEVELS};
use std::collections::HashMap;
use std::sync::Arc;

pub const MAGIC: &[u8; 4] = b"RPMT";
pub const FORMAT_VERSION: u16 = 1;
pub const HEADER_BYTES: usize = 56;
pub const ROAD_BYTES: usize = 12;
pub const FLAG_TRUNCATED: u8 = 1;
/// Upper bounds of one tile: about 1.3 MB at most.
pub const MAX_TILE_ROADS: usize = 30_000;
pub const MAX_TILE_POINTS: usize = 120_000;
/// Memory for cached tiles.
pub const CACHE_BUDGET_BYTES: usize = 64 * 1024 * 1024;
/// Tiles beyond this index cannot hold map data (±2³¹ world units would be absurd); refused.
pub const MAX_TILE_INDEX: i32 = 1 << 20;

// The limits bound every response to about 1.3 MB.
const _: () = assert!(HEADER_BYTES + MAX_TILE_ROADS * ROAD_BYTES + MAX_TILE_POINTS * 8 < 1_400_000);

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct TileKey {
    pub content_id: u64,
    pub level: u8,
    pub x: i32,
    pub z: i32,
}

/// Encodes one tile. A tile without roads is a valid, empty tile.
pub fn encode(map: &DisplayMap, content_id: u64, level: u8, x: i32, z: i32) -> Vec<u8> {
    encode_limited(
        map,
        content_id,
        level,
        x,
        z,
        MAX_TILE_ROADS,
        MAX_TILE_POINTS,
    )
}

fn encode_limited(
    map: &DisplayMap,
    content_id: u64,
    level: u8,
    x: i32,
    z: i32,
    max_roads: usize,
    max_points: usize,
) -> Vec<u8> {
    let display = &map.levels[usize::from(level)];
    let size = LEVELS[usize::from(level)].tile_size;
    let (ox, oz) = (f64::from(x) * size, f64::from(z) * size);
    let ids: &[u32] = display.tiles.get(&(x, z)).map_or(&[], Vec::as_slice);

    let mut chosen = Vec::new();
    let mut points = 0usize;
    let mut truncated = false;
    for id in ids {
        let road = &display.roads[*id as usize];
        let n = road.points.len().min(usize::from(u16::MAX));
        if chosen.len() == max_roads || points + n > max_points {
            // Roads are listed most important first: what is dropped is the least important.
            truncated = true;
            break;
        }
        chosen.push((road, n));
        points += n;
    }

    let mut out = Vec::with_capacity(HEADER_BYTES + chosen.len() * ROAD_BYTES + points * 8);
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&FORMAT_VERSION.to_le_bytes());
    out.push(level);
    out.push(if truncated { FLAG_TRUNCATED } else { 0 });
    out.extend_from_slice(&x.to_le_bytes());
    out.extend_from_slice(&z.to_le_bytes());
    out.extend_from_slice(&(size as f32).to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&ox.to_le_bytes());
    out.extend_from_slice(&oz.to_le_bytes());
    out.extend_from_slice(&(chosen.len() as u32).to_le_bytes());
    out.extend_from_slice(&(points as u32).to_le_bytes());
    out.extend_from_slice(&content_id.to_le_bytes());
    let mut first = 0u32;
    for (road, n) in &chosen {
        out.extend_from_slice(&road.index.to_le_bytes());
        out.extend_from_slice(&first.to_le_bytes());
        out.extend_from_slice(&(*n as u16).to_le_bytes());
        out.push(road.class as u8);
        out.push(road.flags);
        first += *n as u32;
    }
    for (road, n) in &chosen {
        for p in &road.points[..*n] {
            out.extend_from_slice(&((f64::from(p[0]) - ox) as f32).to_le_bytes());
            out.extend_from_slice(&((f64::from(p[1]) - oz) as f32).to_le_bytes());
        }
    }
    out
}

/// Least-recently-used cache of encoded tiles, bounded by bytes.
#[derive(Debug, Default)]
pub struct TileCache {
    entries: HashMap<TileKey, (Arc<Vec<u8>>, u64)>,
    bytes: usize,
    tick: u64,
    budget: usize,
}

impl TileCache {
    pub fn new(budget: usize) -> Self {
        Self {
            budget,
            ..Self::default()
        }
    }

    pub fn get(&mut self, key: &TileKey) -> Option<Arc<Vec<u8>>> {
        self.tick += 1;
        let tick = self.tick;
        self.entries.get_mut(key).map(|(tile, used)| {
            *used = tick;
            tile.clone()
        })
    }

    pub fn insert(&mut self, key: TileKey, tile: Arc<Vec<u8>>) {
        self.tick += 1;
        self.bytes += tile.len();
        if let Some((old, _)) = self.entries.insert(key, (tile, self.tick)) {
            self.bytes -= old.len();
        }
        while self.bytes > self.budget && self.entries.len() > 1 {
            let oldest = self
                .entries
                .iter()
                .filter(|(k, _)| **k != key)
                .min_by_key(|(_, (_, used))| *used)
                .map(|(k, _)| *k);
            let Some(oldest) = oldest else { break };
            if let Some((tile, _)) = self.entries.remove(&oldest) {
                self.bytes -= tile.len();
            }
        }
    }

    pub fn clear(&mut self) {
        self.entries.clear();
        self.bytes = 0;
    }

    #[cfg(test)]
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    #[cfg(test)]
    pub fn bytes(&self) -> usize {
        self.bytes
    }
}

/// A decoded road: package road index, class, flags, world points.
#[cfg(test)]
pub type DecodedRoad = (u32, u8, u8, Vec<[f64; 2]>);

/// Reads a tile back (tests and measurements); mirrors `src/domain/mapTile.ts`. Returns level,
/// x, z, truncated and the roads.
#[cfg(test)]
pub fn decode(bytes: &[u8]) -> Option<(u8, i32, i32, bool, Vec<DecodedRoad>)> {
    let u32_at = |o: usize| Some(u32::from_le_bytes(bytes.get(o..o + 4)?.try_into().ok()?));
    let f32_at = |o: usize| Some(f32::from_le_bytes(bytes.get(o..o + 4)?.try_into().ok()?));
    let f64_at = |o: usize| Some(f64::from_le_bytes(bytes.get(o..o + 8)?.try_into().ok()?));
    if bytes.get(0..4)? != MAGIC || u16::from_le_bytes(bytes.get(4..6)?.try_into().ok()?) != 1 {
        return None;
    }
    let (level, flags) = (bytes[6], bytes[7]);
    let x = u32_at(8)? as i32;
    let z = u32_at(12)? as i32;
    let (ox, oz) = (f64_at(24)?, f64_at(32)?);
    let (roads, points) = (u32_at(40)? as usize, u32_at(44)? as usize);
    let base = HEADER_BYTES + roads * ROAD_BYTES;
    if bytes.len() != base + points * 8 {
        return None;
    }
    let mut out = Vec::new();
    for r in 0..roads {
        let o = HEADER_BYTES + r * ROAD_BYTES;
        let first = u32_at(o + 4)? as usize;
        let n = usize::from(u16::from_le_bytes(
            bytes.get(o + 8..o + 10)?.try_into().ok()?,
        ));
        let pts = (first..first + n)
            .map(|i| {
                let p = base + i * 8;
                Some([f64::from(f32_at(p)?) + ox, f64::from(f32_at(p + 4)?) + oz])
            })
            .collect::<Option<Vec<_>>>()?;
        out.push((u32_at(o)?, bytes[o + 10], bytes[o + 11], pts));
    }
    Some((level, x, z, flags & FLAG_TRUNCATED != 0, out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::display::build;
    use crate::map::testkit::{Road, TestPackage};
    use roadpilot_map_package::MapPackage;

    fn map(roads: Vec<Road>) -> DisplayMap {
        let pkg = TestPackage::new("ats").roads(roads).write();
        build(MapPackage::open(pkg.dir()).unwrap().data())
    }

    #[test]
    fn encodes_a_tile_and_reads_it_back_in_world_coordinates() {
        let m = map(vec![
            Road::straight(1, (100.0, 200.0), (300.0, 200.0), "traffic_lane.road.local"),
            Road::straight(
                2,
                (100.0, 300.0),
                (100.0, 600.0),
                "traffic_lane.road.freeway",
            ),
        ]);
        let bytes = encode(&m, 0xabcdef, 0, 0, 0);
        assert_eq!(&bytes[0..4], b"RPMT");
        assert_eq!(bytes.len() % 4, 0);
        let (level, x, z, truncated, roads) = decode(&bytes).unwrap();
        assert_eq!((level, x, z, truncated), (0, 0, 0, false));
        assert_eq!(roads.len(), 2);
        // Freeway first.
        assert_eq!(roads[0].1, 0);
        assert_eq!(roads[0].3, vec![[100.0, 300.0], [100.0, 600.0]]);
        assert_eq!(roads[1].3, vec![[100.0, 200.0], [300.0, 200.0]]);
        assert_eq!(
            u64::from_le_bytes(bytes[48..56].try_into().unwrap()),
            0xabcdef
        );
    }

    /// The same bytes are decoded by the frontend test `src/domain/mapTile.test.ts`.
    pub const GOLDEN_TILE_HEX: &str = concat!(
        "52504d540100000001000000ffffffff0000804400000000000000000000904000000000000090c0",
        "0200000004000000c804c419ba70ae20",
        "010000000000000002000001",
        "000000000200000002000202",
        "0000d0410000c0410000d04100006043000098420000f84200008a430000f842",
    );

    #[test]
    fn produces_the_golden_tile_shared_with_the_frontend() {
        let m = map(vec![
            Road::straight(
                1,
                (1100.0, -900.0),
                (1300.0, -900.0),
                "traffic_lane.road.local",
            )
            .without_curve(),
            Road::straight(
                2,
                (1050.0, -1000.0),
                (1050.0, -800.0),
                "traffic_lane.road.freeway",
            ),
        ]);
        let bytes = encode(&m, 0x20ae_70ba_19c4_04c8, 0, 1, -1);
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(hex, GOLDEN_TILE_HEX);
    }

    #[test]
    fn a_road_crossing_tiles_is_in_each_with_coordinates_relative_to_that_tile() {
        let m = map(vec![Road::straight(
            1,
            (-50_000.0, 1000.0),
            (-48_000.0, 1000.0),
            "traffic_lane.road.local",
        )]);
        let size = 1024.0;
        let x0 = (-50_000.0f64 / size).floor() as i32;
        let x1 = (-48_000.0f64 / size).floor() as i32;
        for x in x0..=x1 {
            let bytes = encode(&m, 1, 0, x, 0);
            let (_, _, _, _, roads) = decode(&bytes).unwrap();
            assert_eq!(roads.len(), 1, "tile {x}");
            assert_eq!(roads[0].3, vec![[-50_000.0, 1000.0], [-48_000.0, 1000.0]]);
            let ox = f64::from_le_bytes(bytes[24..32].try_into().unwrap());
            assert_eq!(ox, f64::from(x) * size);
        }
        let (_, _, _, _, beyond) = decode(&encode(&m, 1, 0, x1 + 1, 0)).unwrap();
        assert!(beyond.is_empty());
    }

    #[test]
    fn an_empty_tile_is_valid() {
        let m = map(vec![Road::straight(1, (0.0, 0.0), (10.0, 0.0), "x")]);
        let bytes = encode(&m, 1, 2, 500, -500);
        assert_eq!(bytes.len(), HEADER_BYTES);
        assert!(decode(&bytes).unwrap().4.is_empty());
    }

    #[test]
    fn a_crowded_tile_is_truncated_minor_roads_first() {
        let mut roads: Vec<Road> = (0..20)
            .map(|i| {
                let z = f64::from(i) * 10.0;
                Road::straight(
                    10 + i as u64,
                    (0.0, z),
                    (500.0, z),
                    "traffic_lane.road.local",
                )
            })
            .collect();
        roads.push(Road::straight(
            5,
            (0.0, 900.0),
            (500.0, 900.0),
            "traffic_lane.road.freeway",
        ));
        let m = map(roads);
        // Every road has two points; room for five roads.
        let bytes = encode_limited(&m, 1, 0, 0, 0, 100, 10);
        let (_, _, _, truncated, roads) = decode(&bytes).unwrap();
        assert!(truncated);
        assert_eq!(roads.len(), 5);
        assert_eq!(roads[0].1, 0, "the freeway is kept");
        let bytes = encode_limited(&m, 1, 0, 0, 0, 3, 1000);
        assert_eq!(decode(&bytes).unwrap().4.len(), 3);
        // The real limits bound every response.
        let full = encode(&m, 1, 0, 0, 0);
        assert!(!decode(&full).unwrap().3);
    }

    #[test]
    fn the_cache_evicts_the_least_recently_used_tile_within_its_budget() {
        let key = |x| TileKey {
            content_id: 1,
            level: 0,
            x,
            z: 0,
        };
        let tile = |n| Arc::new(vec![0u8; n]);
        let mut c = TileCache::new(100);
        c.insert(key(1), tile(40));
        c.insert(key(2), tile(40));
        assert!(c.get(&key(1)).is_some()); // 1 is now newer than 2
        c.insert(key(3), tile(40));
        assert!(c.get(&key(2)).is_none(), "least recently used evicted");
        assert!(c.get(&key(1)).is_some());
        assert!(c.get(&key(3)).is_some());
        assert!(c.bytes() <= 100);
        // A tile larger than the budget is still kept on its own.
        c.insert(key(4), tile(150));
        assert_eq!(c.len(), 1);
        c.clear();
        assert_eq!((c.len(), c.bytes()), (0, 0));
    }

    #[test]
    fn cached_tiles_of_different_packages_never_mix() {
        let mut c = TileCache::new(1000);
        let a = TileKey {
            content_id: 1,
            level: 0,
            x: 0,
            z: 0,
        };
        let b = TileKey { content_id: 2, ..a };
        c.insert(a, Arc::new(vec![1]));
        assert!(c.get(&b).is_none());
    }
}
