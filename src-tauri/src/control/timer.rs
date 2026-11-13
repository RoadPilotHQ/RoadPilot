//! What wakes the control loop at each tick deadline.
//!
//! The control loop asks a [`TickTimer`] to resolve at the next deadline of its schedule. The
//! schedule itself (fixed 40 ms grid, skipped deadlines, gap limit) is unchanged and lives in
//! `schedule`; a timer only decides how precisely the loop wakes up.
//!
//! * [`TokioTimer`] uses tokio's timer. Deterministic tests run it on tokio's paused clock. On
//!   Windows it is coarse: tokio waits in whole milliseconds through I/O completion ports, which
//!   the system ends on its default 15.6 ms clock interrupt, so ticks wake up to about 16 ms
//!   late and intervals reach about 56 ms (measured; see `docs/timing.md`).
//! * [`PreciseTimer`] sleeps on a dedicated thread with `std::thread::sleep`, which on Windows
//!   uses a high-resolution waitable timer, and then wakes the control loop through a `watch`
//!   channel. It changes no global timer setting and does not busy-wait. A hook run on the
//!   timer thread lets the application raise that thread's priority.
//!
//! Both timers never resolve before the deadline. Neither replays anything: the timer only
//! wakes the loop, and the loop decides what a tick does.

use super::timing::TimerKind;
use std::future::Future;
use std::pin::Pin;
use std::sync::mpsc;
use std::time::Instant;
use tokio::sync::watch;
use tokio::time::{Instant as TokioInstant, sleep_until};

pub type WaitFuture<'a> = Pin<Box<dyn Future<Output = ()> + Send + 'a>>;

/// Wakes the control loop at a deadline.
pub trait TickTimer: Send + 'static {
    fn kind(&self) -> TimerKind;

    /// Resolves at or after `deadline`, never before. Cancel-safe: the control loop drops the
    /// future whenever another event arrives first and then calls again with the same deadline.
    fn wait_until(&mut self, deadline: Instant) -> WaitFuture<'_>;
}

/// Tokio's timer on whichever runtime polls it.
#[derive(Debug, Default)]
pub struct TokioTimer;

impl TickTimer for TokioTimer {
    fn kind(&self) -> TimerKind {
        TimerKind::Tokio
    }

    fn wait_until(&mut self, deadline: Instant) -> WaitFuture<'_> {
        Box::pin(sleep_until(TokioInstant::from_std(deadline)))
    }
}

/// A dedicated timer thread with high-resolution sleeps.
pub struct PreciseTimer {
    requests: mpsc::Sender<Instant>,
    fired: watch::Receiver<Option<Instant>>,
    requested: Option<Instant>,
}

impl PreciseTimer {
    /// Starts the timer thread. `on_thread_start` runs first on the new thread (the application
    /// raises the thread priority there); its result is returned alongside the timer.
    pub fn start(
        on_thread_start: impl FnOnce() -> bool + Send + 'static,
    ) -> std::io::Result<(Self, bool)> {
        let (requests, request_rx) = mpsc::channel::<Instant>();
        let (fired_tx, fired) = watch::channel(None);
        let (ready_tx, ready_rx) = mpsc::channel();
        std::thread::Builder::new()
            .name("roadpilot-control-timer".into())
            .spawn(move || {
                let _ = ready_tx.send(on_thread_start());
                // Ends when the timer (the only sender) is dropped.
                while let Ok(mut deadline) = request_rx.recv() {
                    // Only the newest deadline matters.
                    while let Ok(newer) = request_rx.try_recv() {
                        deadline = newer;
                    }
                    // The loop re-checks: a sleep must never end the wait early.
                    loop {
                        let now = Instant::now();
                        if now >= deadline {
                            break;
                        }
                        std::thread::sleep(deadline - now);
                    }
                    if fired_tx.send(Some(deadline)).is_err() {
                        break;
                    }
                }
            })?;
        let hook_result = ready_rx.recv().unwrap_or(false);
        Ok((
            Self {
                requests,
                fired,
                requested: None,
            },
            hook_result,
        ))
    }
}

impl TickTimer for PreciseTimer {
    fn kind(&self) -> TimerKind {
        TimerKind::Precise
    }

    fn wait_until(&mut self, deadline: Instant) -> WaitFuture<'_> {
        Box::pin(async move {
            if self.requested != Some(deadline) {
                if self.requests.send(deadline).is_err() {
                    // The timer thread is gone: fall back to tokio's timer rather than stall.
                    sleep_until(TokioInstant::from_std(deadline)).await;
                    return;
                }
                self.requested = Some(deadline);
            }
            loop {
                if self
                    .fired
                    .borrow_and_update()
                    .is_some_and(|fired| fired >= deadline)
                {
                    return;
                }
                if self.fired.changed().await.is_err() {
                    sleep_until(TokioInstant::from_std(deadline)).await;
                    return;
                }
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
    }

    #[test]
    fn the_hook_runs_on_the_timer_thread_and_its_result_is_reported() {
        let ran_on: Arc<std::sync::Mutex<Option<String>>> = Arc::default();
        let seen = ran_on.clone();
        let (timer, result) = PreciseTimer::start(move || {
            *seen.lock().unwrap() = std::thread::current().name().map(str::to_owned);
            true
        })
        .unwrap();
        assert!(result);
        assert_eq!(timer.kind(), TimerKind::Precise);
        assert_eq!(
            ran_on.lock().unwrap().as_deref(),
            Some("roadpilot-control-timer")
        );
    }

    #[test]
    fn the_precise_timer_never_resolves_before_the_deadline() {
        let (mut timer, _) = PreciseTimer::start(|| false).unwrap();
        runtime().block_on(async {
            let start = Instant::now();
            for n in 1..=25u64 {
                let deadline = start + ms(n * 10);
                timer.wait_until(deadline).await;
                let now = Instant::now();
                assert!(now >= deadline, "woke {:?} early", deadline - now);
                // Generous bound: this runs alongside the whole test suite.
                assert!(now - deadline < ms(200), "woke {:?} late", now - deadline);
            }
        });
    }

    #[test]
    fn a_past_deadline_resolves_immediately() {
        let (mut timer, _) = PreciseTimer::start(|| false).unwrap();
        runtime().block_on(async {
            let past = Instant::now();
            std::thread::sleep(ms(5));
            let started = Instant::now();
            timer.wait_until(past).await;
            assert!(started.elapsed() < ms(200));
        });
    }

    #[test]
    fn a_dropped_wait_can_be_resumed_for_the_same_deadline() {
        let (mut timer, _) = PreciseTimer::start(|| false).unwrap();
        runtime().block_on(async {
            let deadline = Instant::now() + ms(60);
            // Another event wins first: the wait future is dropped unfinished.
            tokio::select! {
                () = timer.wait_until(deadline) => panic!("must not resolve before the deadline"),
                () = tokio::time::sleep(ms(10)) => {}
            }
            timer.wait_until(deadline).await;
            assert!(Instant::now() >= deadline);
        });
    }

    #[test]
    fn an_older_fired_deadline_does_not_satisfy_a_newer_one() {
        let (mut timer, _) = PreciseTimer::start(|| false).unwrap();
        runtime().block_on(async {
            let first = Instant::now() + ms(5);
            timer.wait_until(first).await;
            let second = Instant::now() + ms(40);
            timer.wait_until(second).await;
            assert!(Instant::now() >= second);
        });
    }

    #[test]
    fn the_timer_thread_ends_when_the_timer_is_dropped() {
        struct SetOnExit(Arc<AtomicBool>);
        impl Drop for SetOnExit {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }
        thread_local! {
            static ON_EXIT: std::cell::RefCell<Option<SetOnExit>> = const { std::cell::RefCell::new(None) };
        }
        let ended = Arc::new(AtomicBool::new(false));
        let flag = ended.clone();
        // Thread-local destructors run when the timer thread exits.
        let (timer, _) = PreciseTimer::start(move || {
            ON_EXIT.with(|slot| *slot.borrow_mut() = Some(SetOnExit(flag)));
            true
        })
        .unwrap();
        assert!(!ended.load(Ordering::SeqCst));
        drop(timer);
        let start = Instant::now();
        while !ended.load(Ordering::SeqCst) {
            assert!(start.elapsed() < ms(2_000), "the timer thread did not exit");
            std::thread::sleep(ms(5));
        }
    }

    #[test]
    fn the_tokio_timer_resolves_at_the_deadline_on_virtual_time() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .start_paused(true)
            .build()
            .unwrap();
        rt.block_on(async {
            let mut timer = TokioTimer;
            assert_eq!(timer.kind(), TimerKind::Tokio);
            let start = TokioInstant::now().into_std();
            let deadline = start + ms(40);
            timer.wait_until(deadline).await;
            assert_eq!(TokioInstant::now().into_std(), deadline);
        });
    }
}
