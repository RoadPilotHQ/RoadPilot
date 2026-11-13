//! CPU load generator for timing measurements: busy threads at normal priority.
//!
//! Usage: `cargo run --release --example cpu_load -- [threads] [seconds]`
//! Defaults: one thread per logical CPU, 60 seconds.

use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let threads: usize = args.get(1).and_then(|s| s.parse().ok()).unwrap_or_else(|| {
        std::thread::available_parallelism()
            .map(|n| n.get())
            .unwrap_or(4)
    });
    let seconds: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(60);
    println!("cpu_load: {threads} busy threads for {seconds} s");
    let end = Instant::now() + Duration::from_secs(seconds);
    // Completed work units, so the throughput of this load can be compared with and without
    // other software (for example RoadPilot's elevated control threads) running.
    let rounds = Arc::new(AtomicU64::new(0));
    let workers: Vec<_> = (0..threads)
        .map(|_| {
            let rounds = rounds.clone();
            std::thread::spawn(move || {
                let mut x = 0u64;
                let mut done = 0u64;
                while Instant::now() < end {
                    for i in 0..10_000u64 {
                        x = x.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(i);
                    }
                    std::hint::black_box(x);
                    done += 1;
                }
                rounds.fetch_add(done, Ordering::Relaxed);
            })
        })
        .collect();
    for worker in workers {
        let _ = worker.join();
    }
    println!(
        "cpu_load: {} rounds of 10000 iterations",
        rounds.load(Ordering::Relaxed)
    );
}
