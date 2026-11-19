//! The map service: one package at a time, for the game the dashboard shows.
//!
//! Selecting a package (or another game) releases the previous one at once, then loads the
//! new one on a background thread. Every request gets a generation number; a load that was
//! overtaken by a newer request is discarded, so a slow ATS load can never appear while ETS2
//! is selected.

use super::loader::{self, LoadFailure, LoadedMap};
use super::status::{MapError, MapErrorCode, MapState, MapStatus};
use crate::telemetry::model::Game;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

/// Receives every status change (the application emits `map:status`).
pub type StatusListener = Box<dyn Fn(&MapStatus) + Send + Sync>;

#[derive(Clone, Debug, PartialEq, Eq)]
struct Request {
    game: Game,
    dir: PathBuf,
}

struct Inner {
    generation: u64,
    revision: u64,
    request: Option<Request>,
    status: MapStatus,
    loaded: Option<Arc<LoadedMap>>,
    #[cfg(test)]
    worker: Option<std::thread::JoinHandle<()>>,
}

struct Shared {
    inner: Mutex<Inner>,
    listener: Option<StatusListener>,
}

#[derive(Clone)]
pub struct MapService {
    shared: Arc<Shared>,
}

impl MapService {
    pub fn new(listener: Option<StatusListener>) -> Self {
        Self {
            shared: Arc::new(Shared {
                inner: Mutex::new(Inner {
                    generation: 0,
                    revision: 0,
                    request: None,
                    status: MapStatus::none(None, 0),
                    loaded: None,
                    #[cfg(test)]
                    worker: None,
                }),
                listener,
            }),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        // A panic while holding the lock cannot leave the map in a dangerous state: the map is
        // display-only. Continue with the data as it is.
        self.shared.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn status(&self) -> MapStatus {
        self.lock().status.clone()
    }

    /// The loaded map, if it is ready and belongs to `game`.
    // Read by the tile commands of step 2.4B; until then only by tests.
    #[cfg_attr(not(test), allow(dead_code))]
    pub fn loaded(&self, game: Game) -> Option<Arc<LoadedMap>> {
        let inner = self.lock();
        inner.loaded.clone().filter(|m| m.game == game)
    }

    /// Selects the map for `game` from `dir`. `None` for either releases the map. The same
    /// selection again keeps a loaded or loading map, unless `reload` is set or the last
    /// attempt failed.
    pub fn select(&self, game: Option<Game>, dir: Option<PathBuf>, reload: bool) -> MapStatus {
        let mut inner = self.lock();
        let request = game.zip(dir).map(|(game, dir)| Request { game, dir });
        let failed = !matches!(
            inner.status.state,
            MapState::Ready | MapState::Loading | MapState::Selecting
        );
        if request == inner.request && !reload && !failed && request.is_some() {
            return inner.status.clone();
        }
        if request.is_none() && inner.request.is_none() && inner.status.game == game {
            return inner.status.clone();
        }

        // Release first: nothing of the previous selection stays in use.
        inner.generation += 1;
        inner.loaded = None;
        inner.request = request.clone();
        let generation = inner.generation;
        let Some(request) = request else {
            let status = MapStatus::none(game, 0);
            return self.publish(inner, status);
        };

        let mut status = MapStatus::none(Some(request.game), 0);
        status.state = MapState::Selecting;
        let status = self.publish(inner, status);

        let service = self.clone();
        let worker = std::thread::Builder::new()
            .name("roadpilot-map-loader".into())
            .spawn(move || service.run_load(generation, request));
        match worker {
            #[cfg(test)]
            Ok(handle) => self.lock().worker = Some(handle),
            #[cfg(not(test))]
            Ok(_) => {}
            Err(_) => {
                let inner = self.lock();
                let mut status = inner.status.clone();
                status.state = MapState::Error;
                status.error = Some(MapError {
                    code: MapErrorCode::Unreadable,
                    detail: "the loader thread could not be started".into(),
                });
                return self.publish(inner, status);
            }
        }
        status
    }

    /// Stores `status` with the next revision and notifies the listener, outside the lock.
    fn publish(&self, mut inner: MutexGuard<'_, Inner>, mut status: MapStatus) -> MapStatus {
        inner.revision += 1;
        status.revision = inner.revision;
        inner.status = status.clone();
        drop(inner);
        if let Some(listener) = &self.shared.listener {
            listener(&status);
        }
        status
    }

    /// Updates the status only if `generation` is still the current request.
    fn update(&self, generation: u64, change: impl FnOnce(&mut MapStatus, &mut Inner)) {
        let mut inner = self.lock();
        if inner.generation != generation {
            return;
        }
        let mut status = inner.status.clone();
        change(&mut status, &mut inner);
        self.publish(inner, status);
    }

    fn run_load(&self, generation: u64, request: Request) {
        let result = loader::load(&request.dir, request.game, &|phase| {
            self.update(generation, |s, _| {
                s.state = if phase == super::status::LoadPhase::Manifest {
                    MapState::Selecting
                } else {
                    MapState::Loading
                };
                s.phase = Some(phase);
            });
        });
        self.update(generation, |s, inner| {
            s.phase = None;
            match result {
                Ok(map) => {
                    s.state = MapState::Ready;
                    s.package_game = Some(loader::game_name(map.game).to_owned());
                    s.content_id = Some(map.content_id_hex());
                    s.schema = Some(map.schema.clone());
                    s.counts = Some(map.counts);
                    s.bounds = Some(map.bounds);
                    s.load_ms = Some(map.load_ms);
                    inner.loaded = Some(Arc::new(map));
                }
                Err(LoadFailure::GameMismatch { package_game }) => {
                    s.state = MapState::GameMismatch;
                    s.package_game = Some(package_game);
                }
                Err(LoadFailure::UnsupportedVersion { major }) => {
                    s.state = MapState::UnsupportedVersion;
                    s.schema = Some(format!("{major}"));
                }
                Err(LoadFailure::Failed(error)) => {
                    s.state = MapState::Error;
                    s.error = Some(error);
                }
            }
        });
    }

    /// Waits for the current background load (tests only).
    #[cfg(test)]
    pub fn wait(&self) -> MapStatus {
        let worker = self.lock().worker.take();
        if let Some(worker) = worker {
            worker.join().unwrap();
        }
        self.status()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::loader::game_name;
    use crate::map::testkit::{Road, TestPackage, WrittenPackage};
    use std::sync::Weak;

    fn package(game: Game) -> WrittenPackage {
        TestPackage::new(game_name(game))
            .road(Road::straight(
                1,
                (0.0, 0.0),
                (100.0, 0.0),
                "traffic_lane.road.local",
            ))
            .write()
    }

    fn recorder() -> (MapService, Arc<Mutex<Vec<MapStatus>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = seen.clone();
        let service = MapService::new(Some(Box::new(move |s: &MapStatus| {
            sink.lock().unwrap().push(s.clone())
        })));
        (service, seen)
    }

    #[test]
    fn starts_without_a_map() {
        let s = MapService::new(None);
        assert_eq!(s.status().state, MapState::None);
        assert!(s.loaded(Game::Ats).is_none());
    }

    #[test]
    fn loads_in_the_background_and_reports_every_step() {
        let (service, seen) = recorder();
        let pkg = package(Game::Ats);
        let first = service.select(Some(Game::Ats), Some(pkg.dir().into()), false);
        assert_eq!(first.state, MapState::Selecting);
        let done = service.wait();
        assert_eq!(done.state, MapState::Ready);
        assert_eq!(done.content_id, Some(format!("{:016x}", pkg.content_id())));
        assert_eq!(done.counts.unwrap().roads, 1);
        assert!(service.loaded(Game::Ats).is_some());
        assert!(
            service.loaded(Game::Ets2).is_none(),
            "never the other game's map"
        );
        let states: Vec<MapState> = seen.lock().unwrap().iter().map(|s| s.state).collect();
        assert_eq!(states.first(), Some(&MapState::Selecting));
        assert!(states.contains(&MapState::Loading));
        assert_eq!(states.last(), Some(&MapState::Ready));
        let revisions: Vec<u64> = seen.lock().unwrap().iter().map(|s| s.revision).collect();
        assert!(revisions.windows(2).all(|w| w[0] < w[1]), "{revisions:?}");
    }

    #[test]
    fn the_same_selection_keeps_the_loaded_map() {
        let service = MapService::new(None);
        let pkg = package(Game::Ets2);
        service.select(Some(Game::Ets2), Some(pkg.dir().into()), false);
        let ready = service.wait();
        let again = service.select(Some(Game::Ets2), Some(pkg.dir().into()), false);
        assert_eq!(again.revision, ready.revision, "no reload");
        let reloaded = service.select(Some(Game::Ets2), Some(pkg.dir().into()), true);
        assert!(reloaded.revision > ready.revision);
        assert_eq!(service.wait().state, MapState::Ready);
    }

    #[test]
    fn switching_games_releases_the_previous_map_immediately() {
        let service = MapService::new(None);
        let ats = package(Game::Ats);
        let ets2 = package(Game::Ets2);
        service.select(Some(Game::Ats), Some(ats.dir().into()), false);
        service.wait();
        let weak: Weak<LoadedMap> = Arc::downgrade(&service.loaded(Game::Ats).unwrap());

        let switching = service.select(Some(Game::Ets2), Some(ets2.dir().into()), false);
        assert_eq!(switching.state, MapState::Selecting);
        assert_eq!(switching.game, Some(Game::Ets2));
        assert!(
            switching.content_id.is_none(),
            "no ATS data in the ETS2 status"
        );
        assert!(weak.upgrade().is_none(), "the ATS map is released");
        assert!(service.loaded(Game::Ats).is_none());
        let ready = service.wait();
        assert_eq!(
            ready.content_id,
            Some(format!("{:016x}", ets2.content_id()))
        );
        assert!(service.loaded(Game::Ets2).is_some());
    }

    #[test]
    fn clearing_the_selection_releases_the_map() {
        let service = MapService::new(None);
        let pkg = package(Game::Ats);
        service.select(Some(Game::Ats), Some(pkg.dir().into()), false);
        service.wait();
        let weak = Arc::downgrade(&service.loaded(Game::Ats).unwrap());
        let none = service.select(Some(Game::Ats), None, false);
        assert_eq!(none.state, MapState::None);
        assert!(weak.upgrade().is_none());
        let no_game = service.select(None, Some(pkg.dir().into()), false);
        assert_eq!(no_game.state, MapState::None);
        assert_eq!(no_game.game, None);
    }

    #[test]
    fn a_package_of_the_wrong_game_is_never_loaded() {
        let service = MapService::new(None);
        let ets2 = package(Game::Ets2);
        service.select(Some(Game::Ats), Some(ets2.dir().into()), false);
        let s = service.wait();
        assert_eq!(s.state, MapState::GameMismatch);
        assert_eq!(s.package_game.as_deref(), Some("ets2"));
        assert!(service.loaded(Game::Ats).is_none());
        assert!(service.loaded(Game::Ets2).is_none());
    }

    #[test]
    fn reports_unsupported_versions_and_load_errors() {
        let service = MapService::new(None);
        let v2 = TestPackage::new("ats")
            .road(Road::straight(1, (0.0, 0.0), (10.0, 0.0), "x"))
            .schema_major(2)
            .write();
        service.select(Some(Game::Ats), Some(v2.dir().into()), false);
        let s = service.wait();
        assert_eq!(s.state, MapState::UnsupportedVersion);
        assert_eq!(s.schema.as_deref(), Some("2"));

        let missing = std::env::temp_dir().join("roadpilot-no-such-package");
        service.select(Some(Game::Ats), Some(missing), false);
        let s = service.wait();
        assert_eq!(s.state, MapState::Error);
        assert_eq!(s.error.unwrap().code, MapErrorCode::NotFound);
    }

    #[test]
    fn a_failed_selection_is_retried_when_selected_again() {
        let service = MapService::new(None);
        let pkg = package(Game::Ats);
        let manifest = std::fs::read(pkg.dir().join("manifest.json")).unwrap();
        std::fs::remove_file(pkg.dir().join("manifest.json")).unwrap();
        service.select(Some(Game::Ats), Some(pkg.dir().into()), false);
        assert_eq!(service.wait().state, MapState::Error);
        std::fs::write(pkg.dir().join("manifest.json"), manifest).unwrap();
        service.select(Some(Game::Ats), Some(pkg.dir().into()), false);
        assert_eq!(service.wait().state, MapState::Ready);
    }

    #[test]
    fn an_overtaken_load_is_discarded() {
        let service = MapService::new(None);
        let ats = package(Game::Ats);
        let ets2 = package(Game::Ets2);
        // Two requests back to back: the first load must not win.
        service.select(Some(Game::Ats), Some(ats.dir().into()), false);
        let first = service.lock().worker.take().unwrap();
        service.select(Some(Game::Ets2), Some(ets2.dir().into()), false);
        first.join().unwrap();
        let s = service.wait();
        assert_eq!(s.game, Some(Game::Ets2));
        assert_eq!(s.content_id, Some(format!("{:016x}", ets2.content_id())));
        assert!(service.loaded(Game::Ats).is_none());
    }
}
