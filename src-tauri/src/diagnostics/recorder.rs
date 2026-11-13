//! Diagnostic telemetry recorder: writes every observed telemetry frame and every control log
//! record to a JSON Lines file, for the analysis of live test drives.
//!
//! # Activation
//!
//! Only through the environment variable [`ENV_VAR`] (`ROADPILOT_TELEMETRY_RECORD`), whose
//! value is the path of a new file. Without it, or with an empty value, no recorder exists:
//! no thread, no queue, no file, and the control log has no observer. An existing file is
//! never overwritten; recording is then disabled and the application runs as without it.
//!
//! # What is recorded (one JSON object per line, format version [`FORMAT_VERSION`])
//!
//! * `start`: first line; format, application version, queue capacity, wall clock.
//! * `frame`: every telemetry frame observed on the engine's frame channel, with session,
//!   sequence, simulation time, plugin state, dropped fields and the complete frame. A
//!   sequence number skipped within a session is stated explicitly (`sequenceGap`); so is a
//!   session change (`sessionChanged`).
//!   Each frame also carries the reader's `receivedQpc` and its `timing` from the QPC
//!   stamps (plugin processing, transport, age at receive in µs), or why it is invalid.
//! * `control`: every record of the control log (decisions, timing, messages) as it is
//!   logged, before the in-memory rings could drop it, and every change of the freshness
//!   assessment.
//! * `feed`: the frame channel was attached, lost or replaced (pipe server restart).
//! * `loss`: queue overflows or failed writes since the previous loss record, with totals.
//! * `end`: last line; how many records were queued, written, lost to a full queue, lost to
//!   write errors or rejected after the stop, and whether the recording is complete.
//!
//! Times: `monoUs` is microseconds on the monotonic clock since the recorder started (the
//! clock the control loop uses); `unixUs` is the wall clock derived from it. Frames carry
//! their receive time, control records the time they were observed; `atUs` is a control
//! record's time since the control log's origin.
//!
//! # Never in the way of control
//!
//! * The control thread only calls [`RecorderSink::push`]: a few atomic operations and one
//!   `try_send` into a bounded queue. It never blocks, allocates for control records, or waits
//!   for I/O. If the queue is full the record is dropped and counted, never waited for.
//! * The queue is `std::sync::mpsc::sync_channel` (a bounded array channel). Its `try_send`
//!   takes a lock only to wake a receiver that is blocked in `recv`. The writer never blocks
//!   in `recv`: it polls with `try_recv` and sleeps in between, so no sender ever contends a
//!   lock with it.
//! * All serialization and file I/O happen on the writer thread at normal priority.
//! * Frames are observed on a separate thread at above-normal priority (below the control
//!   threads) from a receiver on the engine's frame channel, like the control relay. A frame
//!   replaced before this thread saw it shows up as a `sequenceGap`, never silently.
//! * Nothing here opens the input plugin's pipe or sends anything to the game; a test scans
//!   this file for it.

use crate::control::freshness::{Assessment, Unusable};
use crate::control::latency::{LatencyEvent, Measure};
use crate::control::log::{LogObserver, Observed};
use crate::control::runtime::FrameSource;
use crate::control::status::{LogEntryDto, freshness};
use crate::platform;
use roadpilot_telemetry_client::{PluginState, ReceivedTelemetryFrame};
use serde_json::{Value, json};
use std::ffi::OsString;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::mpsc::{Receiver, SyncSender, TryRecvError, TrySendError, sync_channel};
use std::thread::JoinHandle;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;

pub const ENV_VAR: &str = "ROADPILOT_TELEMETRY_RECORD";
/// 1: initial format. 2: frames add `receivedQpc` and `timing`.
pub const FORMAT_VERSION: u32 = 2;
/// Records the queue holds before it overflows: about 4 minutes of 60 Hz frames.
pub const QUEUE_CAPACITY: usize = 16_384;
/// How long [`Recorder::finish`] waits for the queue to be written out.
pub const FINISH_TIMEOUT: Duration = Duration::from_secs(5);
const WRITER_POLL: Duration = Duration::from_millis(20);
const FEED_POLL: Duration = Duration::from_millis(50);
const IN_FLIGHT_WAIT: Duration = Duration::from_secs(1);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Kind {
    Frame,
    Control,
    Feed,
}

enum Item {
    Frame {
        received: Box<ReceivedTelemetryFrame>,
        sequence_gap: Option<u64>,
        session_changed: bool,
    },
    Control {
        observed_at: Instant,
        record: Observed,
    },
    Feed {
        at: Instant,
        attached: bool,
    },
}

impl Item {
    fn kind(&self) -> Kind {
        match self {
            Item::Frame { .. } => Kind::Frame,
            Item::Control { .. } => Kind::Control,
            Item::Feed { .. } => Kind::Feed,
        }
    }
}

/// Record counts by kind.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct Counts {
    pub frames: u64,
    pub control: u64,
    pub feed: u64,
}

impl Counts {
    fn add(&mut self, kind: Kind, n: u64) {
        match kind {
            Kind::Frame => self.frames += n,
            Kind::Control => self.control += n,
            Kind::Feed => self.feed += n,
        }
    }

    fn total(&self) -> u64 {
        self.frames + self.control + self.feed
    }

    fn json(&self) -> Value {
        json!({ "frames": self.frames, "control": self.control, "feed": self.feed })
    }
}

#[derive(Debug, Default)]
struct AtomicCounts {
    frames: AtomicU64,
    control: AtomicU64,
    feed: AtomicU64,
}

impl AtomicCounts {
    fn add(&self, kind: Kind) {
        match kind {
            Kind::Frame => &self.frames,
            Kind::Control => &self.control,
            Kind::Feed => &self.feed,
        }
        .fetch_add(1, SeqCst);
    }

    fn get(&self) -> Counts {
        Counts {
            frames: self.frames.load(SeqCst),
            control: self.control.load(SeqCst),
            feed: self.feed.load(SeqCst),
        }
    }
}

/// State shared by the senders and the writer. Atomics only.
#[derive(Debug, Default)]
struct Shared {
    queued: AtomicCounts,
    queue_full: AtomicCounts,
    rejected_after_stop: AtomicU64,
    /// Pushes currently between their stop check and their `try_send`.
    in_flight: AtomicU64,
    stopping: AtomicBool,
}

/// The sending side. Cheap to clone; never blocks.
#[derive(Clone)]
pub struct RecorderSink {
    tx: SyncSender<Item>,
    shared: Arc<Shared>,
}

impl RecorderSink {
    fn push(&self, item: Item) {
        let shared = &self.shared;
        // Announce the push before checking the stop flag: the writer, after setting
        // `stopping`, waits until no push is in flight, so every record either reaches the
        // queue before the final drain or is counted as rejected. Nothing is lost silently.
        shared.in_flight.fetch_add(1, SeqCst);
        let kind = item.kind();
        if shared.stopping.load(SeqCst) {
            shared.rejected_after_stop.fetch_add(1, SeqCst);
        } else {
            match self.tx.try_send(item) {
                Ok(()) => shared.queued.add(kind),
                Err(TrySendError::Full(_)) => shared.queue_full.add(kind),
                Err(TrySendError::Disconnected(_)) => {
                    shared.rejected_after_stop.fetch_add(1, SeqCst);
                }
            }
        }
        shared.in_flight.fetch_sub(1, SeqCst);
    }
}

impl LogObserver for RecorderSink {
    fn observe(&self, record: Observed) {
        self.push(Item::Control {
            observed_at: Instant::now(),
            record,
        });
    }
}

/// Maps monotonic instants to the recorder's time base and to the wall clock.
#[derive(Clone, Copy, Debug)]
struct Clock {
    base: Instant,
    base_unix_us: i128,
}

impl Clock {
    fn start() -> Self {
        Self {
            base: Instant::now(),
            base_unix_us: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_or(0, |d| d.as_micros() as i128),
        }
    }

    fn mono_us(&self, at: Instant) -> i64 {
        if at >= self.base {
            at.duration_since(self.base).as_micros() as i64
        } else {
            -(self.base.duration_since(at).as_micros() as i64)
        }
    }

    fn unix_us(&self, at: Instant) -> i64 {
        (self.base_unix_us + i128::from(self.mono_us(at))) as i64
    }
}

/// What a finished recording reports.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Summary {
    pub queued: Counts,
    pub written: Counts,
    pub queue_full: Counts,
    /// Records (including start, loss and end lines) whose write failed.
    pub write_failed: u64,
    pub first_write_error: Option<String>,
    pub rejected_after_stop: u64,
    pub complete: bool,
}

/// The writing side: drains the queue on its own thread and owns the output.
struct Writer<W: Write> {
    rx: Receiver<Item>,
    out: W,
    shared: Arc<Shared>,
    clock: Clock,
    capacity: usize,
    written: Counts,
    write_failed: u64,
    first_write_error: Option<String>,
    /// Totals at the last loss record.
    reported_queue_full: Counts,
    reported_write_failed: u64,
}

/// A queue of `capacity` records and its writer, not yet running.
fn channel<W: Write>(out: W, capacity: usize) -> (RecorderSink, Writer<W>) {
    let capacity = capacity.max(1);
    let (tx, rx) = sync_channel(capacity);
    let shared = Arc::new(Shared::default());
    (
        RecorderSink {
            tx,
            shared: shared.clone(),
        },
        Writer {
            rx,
            out,
            shared,
            clock: Clock::start(),
            capacity,
            written: Counts::default(),
            write_failed: 0,
            first_write_error: None,
            reported_queue_full: Counts::default(),
            reported_write_failed: 0,
        },
    )
}

impl<W: Write> Writer<W> {
    /// Writes until stopped: drains the queue, writes the batch, reports losses, sleeps
    /// (unparked early by [`Recorder::finish`]). On stop it waits for in-flight pushes, drains
    /// the queue completely and writes the end record.
    fn run(mut self, poll: Duration) -> Summary {
        let start = self.start_line();
        self.write(vec![(None, start)]);
        loop {
            let stopping = self.shared.stopping.load(SeqCst);
            if stopping {
                self.wait_for_in_flight();
            }
            let (batch, disconnected) = self.drain();
            let mut lines = batch;
            if let Some(loss) = self.loss_line() {
                lines.push((None, loss));
            }
            self.write(lines);
            if stopping || disconnected {
                // A failure of the last batch is reported before the end record.
                let mut last = Vec::new();
                if let Some(loss) = self.loss_line() {
                    last.push((None, loss));
                }
                last.push((None, self.end_line()));
                self.write(last);
                let summary = self.summary();
                if !summary.complete {
                    eprintln!("RoadPilot: telemetry recording incomplete: {summary:?}");
                }
                return summary;
            }
            std::thread::park_timeout(poll);
        }
    }

    fn wait_for_in_flight(&self) {
        let until = Instant::now() + IN_FLIGHT_WAIT;
        while self.shared.in_flight.load(SeqCst) > 0 && Instant::now() < until {
            std::thread::yield_now();
        }
    }

    fn drain(&mut self) -> (Vec<(Option<Kind>, String)>, bool) {
        let mut lines = Vec::new();
        loop {
            match self.rx.try_recv() {
                Ok(item) => {
                    let kind = item.kind();
                    lines.push((Some(kind), self.line(item)));
                }
                Err(TryRecvError::Empty) => return (lines, false),
                Err(TryRecvError::Disconnected) => return (lines, true),
            }
        }
    }

    /// Writes the lines in one call. On failure every line of the batch counts as lost.
    fn write(&mut self, lines: Vec<(Option<Kind>, String)>) {
        if lines.is_empty() {
            return;
        }
        let mut buffer = Vec::with_capacity(lines.iter().map(|(_, l)| l.len() + 1).sum());
        for (_, line) in &lines {
            buffer.extend_from_slice(line.as_bytes());
            buffer.push(b'\n');
        }
        match self.out.write_all(&buffer).and_then(|()| self.out.flush()) {
            Ok(()) => {
                for (kind, _) in &lines {
                    if let Some(kind) = kind {
                        self.written.add(*kind, 1);
                    }
                }
            }
            Err(error) => {
                if self.first_write_error.is_none() {
                    eprintln!("RoadPilot: telemetry recording write failed: {error}");
                    self.first_write_error = Some(error.to_string());
                }
                self.write_failed += lines.len() as u64;
            }
        }
    }

    fn stamp(&self, mut value: Value, kind: &str, at: Instant) -> String {
        value["type"] = json!(kind);
        value["monoUs"] = json!(self.clock.mono_us(at));
        value["unixUs"] = json!(self.clock.unix_us(at));
        value.to_string()
    }

    fn line(&self, item: Item) -> String {
        match item {
            Item::Frame {
                received,
                sequence_gap,
                session_changed,
            } => {
                let f = &received.frame;
                let value = json!({
                    "session": f.session,
                    "sequence": f.sequence,
                    "sequenceGap": sequence_gap,
                    "sessionChanged": session_changed,
                    "game": f.game,
                    "gameVersion": f.game_version,
                    "pluginState": f.plugin_state,
                    "paused": f.plugin_state == PluginState::Paused,
                    "simulationTimeUs": f.simulation_time_us,
                    "droppedFields": received.dropped_fields,
                    "receivedQpc": received.received_qpc,
                    "timing": frame_timing(&received),
                    "frame": f,
                });
                self.stamp(value, "frame", received.received_at)
            }
            Item::Control {
                observed_at,
                record,
            } => self.stamp(control_json(record), "control", observed_at),
            Item::Feed { at, attached } => self.stamp(
                json!({ "event": if attached { "attached" } else { "lost" } }),
                "feed",
                at,
            ),
        }
    }

    fn start_line(&self) -> String {
        self.stamp(
            json!({
                "formatVersion": FORMAT_VERSION,
                "app": "roadpilot",
                "appVersion": env!("CARGO_PKG_VERSION"),
                "queueCapacity": self.capacity,
                "note": "Diagnostics only. Dry run: nothing is transmitted to the game.",
            }),
            "start",
            self.clock.base,
        )
    }

    /// A loss record if anything was lost since the previous one.
    fn loss_line(&mut self) -> Option<String> {
        let queue_full = self.shared.queue_full.get();
        if queue_full == self.reported_queue_full && self.write_failed == self.reported_write_failed
        {
            return None;
        }
        let since = Counts {
            frames: queue_full.frames - self.reported_queue_full.frames,
            control: queue_full.control - self.reported_queue_full.control,
            feed: queue_full.feed - self.reported_queue_full.feed,
        };
        let value = json!({
            "queueFull": queue_full.json(),
            "queueFullSinceLast": since.json(),
            "writeFailed": self.write_failed,
            "writeFailedSinceLast": self.write_failed - self.reported_write_failed,
            "firstWriteError": self.first_write_error,
        });
        self.reported_queue_full = queue_full;
        self.reported_write_failed = self.write_failed;
        Some(self.stamp(value, "loss", Instant::now()))
    }

    fn end_line(&self) -> String {
        let s = self.summary();
        self.stamp(
            json!({
                "queued": s.queued.json(),
                "written": s.written.json(),
                "queueFull": s.queue_full.json(),
                "writeFailed": s.write_failed,
                "firstWriteError": s.first_write_error,
                "rejectedAfterStop": s.rejected_after_stop,
                "complete": s.complete,
            }),
            "end",
            Instant::now(),
        )
    }

    fn summary(&self) -> Summary {
        let queued = self.shared.queued.get();
        let queue_full = self.shared.queue_full.get();
        let rejected_after_stop = self.shared.rejected_after_stop.load(SeqCst);
        Summary {
            queued,
            written: self.written,
            queue_full,
            write_failed: self.write_failed,
            first_write_error: self.first_write_error.clone(),
            rejected_after_stop,
            complete: queue_full.total() == 0
                && self.write_failed == 0
                && rejected_after_stop == 0
                && self.written == queued,
        }
    }
}

/// The frame's QPC timing, or why there is none (for example `Missing(Produced)` from an
/// older plugin). Diagnostics only: control does not use it yet.
fn frame_timing(received: &ReceivedTelemetryFrame) -> Value {
    match received.timing() {
        Ok(t) => json!({
            "valid": true,
            "pluginProcessingUs": micros(t.plugin_processing),
            "transportUs": micros(t.transport),
            "ageAtReceiveUs": micros(t.age_at_receive),
        }),
        Err(error) => json!({ "valid": false, "error": format!("{error:?}") }),
    }
}

fn micros(d: Duration) -> u64 {
    u64::try_from(d.as_micros()).unwrap_or(u64::MAX)
}

fn entry_json(category: &str, n: u64, at: Duration, entry: Value) -> Value {
    json!({ "category": category, "n": n, "atUs": micros(at), "entry": entry })
}

fn measure_code(measure: Measure) -> &'static str {
    match measure {
        Measure::Processing => "processing",
        Measure::Transport => "transport",
        Measure::AgeAtReceive => "ageAtReceive",
        Measure::AgeAtDecision => "ageAtDecision",
    }
}

fn control_json(record: Observed) -> Value {
    let dto = |dto: LogEntryDto| serde_json::to_value(dto).unwrap_or(Value::Null);
    match record {
        Observed::Decision(e) => entry_json("decision", e.n, e.at, dto(LogEntryDto::decision(&e))),
        Observed::Timing(e) => entry_json("timing", e.n, e.at, dto(LogEntryDto::timing(&e))),
        Observed::Message(e) => entry_json("message", e.n, e.at, dto(LogEntryDto::message(&e))),
        Observed::Latency { at, event } => {
            let (event, measure, value) = match event {
                LatencyEvent::Critical { measure, value } => {
                    ("critical", measure, Some(micros(value)))
                }
                LatencyEvent::DegradedStarted { measure } => ("degradedStarted", measure, None),
                LatencyEvent::DegradedEnded { measure } => ("degradedEnded", measure, None),
            };
            json!({
                "category": "latency",
                "atUs": micros(at),
                "event": event,
                "measure": measure_code(measure),
                "valueUs": value,
            })
        }
        Observed::Assessment { at, assessment } => {
            let (code, detail) = freshness(&assessment);
            let mut value = json!({
                "category": "assessment",
                "atUs": micros(at),
                "freshness": code,
                "detail": detail,
            });
            match assessment {
                Assessment::Usable(sample) => {
                    value["epoch"] = json!(sample.epoch);
                    value["ageUs"] = json!(micros(sample.age));
                }
                Assessment::Unusable(Unusable::Stale { age }) => {
                    value["ageUs"] = json!(micros(age));
                }
                Assessment::Unusable(Unusable::SimulationStalled { stalled_for }) => {
                    value["stalledUs"] = json!(micros(stalled_for));
                }
                Assessment::Unusable(_) => {}
            }
            value
        }
    }
}

/// Remembers the last recorded frame to detect repeats, gaps and session changes.
#[derive(Debug, Default)]
struct FrameTracker {
    last: Option<(Option<u64>, u64)>,
}

impl FrameTracker {
    fn record(
        &mut self,
        receiver: &mut watch::Receiver<Option<ReceivedTelemetryFrame>>,
        sink: &RecorderSink,
    ) {
        let Some(received) = receiver.borrow_and_update().clone() else {
            return;
        };
        let key = (received.frame.session, received.frame.sequence);
        if self.last == Some(key) {
            return;
        }
        let (sequence_gap, session_changed) = match self.last {
            Some((session, sequence)) if session == key.0 => (
                key.1
                    .checked_sub(sequence.saturating_add(1))
                    .filter(|gap| *gap > 0),
                false,
            ),
            Some(_) => (None, true),
            None => (None, false),
        };
        self.last = Some(key);
        sink.push(Item::Frame {
            received: Box::new(received),
            sequence_gap,
            session_changed,
        });
    }
}

/// Runs on the frame observer thread until `stop` is set.
fn observe_frames(source: impl FrameSource, sink: RecorderSink, stop: Arc<AtomicBool>) {
    platform::raise_current_thread_priority_above_normal();
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
    else {
        eprintln!("RoadPilot: telemetry recording cannot observe frames (no runtime)");
        return;
    };
    runtime.block_on(async move {
        let mut tracker = FrameTracker::default();
        while !stop.load(SeqCst) {
            let mut receiver = source.receiver();
            if receiver.has_changed().is_err() {
                // No producer (yet, or any more): look again shortly.
                tokio::time::sleep(FEED_POLL).await;
                continue;
            }
            sink.push(Item::Feed {
                at: Instant::now(),
                attached: true,
            });
            tracker.record(&mut receiver, &sink);
            loop {
                if stop.load(SeqCst) {
                    return;
                }
                tokio::select! {
                    changed = receiver.changed() => {
                        if changed.is_err() {
                            break;
                        }
                        tracker.record(&mut receiver, &sink);
                    }
                    _ = tokio::time::sleep(FEED_POLL) => {}
                }
            }
            // The engine dropped this channel (its pipe server stopped or was restarted).
            sink.push(Item::Feed {
                at: Instant::now(),
                attached: false,
            });
        }
    });
}

fn join_within<T>(handle: JoinHandle<T>, timeout: Duration) -> Option<T> {
    let until = Instant::now() + timeout;
    while !handle.is_finished() {
        if Instant::now() >= until {
            return None;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    handle.join().ok()
}

/// A running recording. Dropping it finishes it like [`Recorder::finish`].
pub struct Recorder {
    sink: RecorderSink,
    path: Option<PathBuf>,
    stop_frames: Arc<AtomicBool>,
    frames: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<Summary>>,
}

impl Recorder {
    /// The recorder requested by [`ENV_VAR`], if any. See the module documentation.
    pub fn from_env() -> Option<Self> {
        Self::from_value(std::env::var_os(ENV_VAR))
    }

    fn from_value(value: Option<OsString>) -> Option<Self> {
        let value = value.filter(|v| !v.is_empty())?;
        let path = PathBuf::from(value);
        match Self::create(&path) {
            Ok(recorder) => {
                eprintln!(
                    "RoadPilot: recording telemetry diagnostics to {}",
                    path.display()
                );
                Some(recorder)
            }
            Err(error) => {
                eprintln!(
                    "RoadPilot: telemetry recording disabled, cannot create {}: {error}",
                    path.display()
                );
                None
            }
        }
    }

    /// Records into a new file at `path`; fails if the file exists.
    pub fn create(path: &Path) -> io::Result<Self> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent)?;
        }
        let file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)?;
        let mut recorder = Self::with_output(file, QUEUE_CAPACITY, WRITER_POLL)?;
        recorder.path = Some(path.to_owned());
        Ok(recorder)
    }

    fn with_output<W: Write + Send + 'static>(
        out: W,
        capacity: usize,
        poll: Duration,
    ) -> io::Result<Self> {
        let (sink, writer) = channel(out, capacity);
        let writer = std::thread::Builder::new()
            .name("roadpilot-recorder-writer".into())
            .spawn(move || writer.run(poll))?;
        Ok(Self {
            sink,
            path: None,
            stop_frames: Arc::new(AtomicBool::new(false)),
            frames: None,
            writer: Some(writer),
        })
    }

    #[cfg(test)]
    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// The observer to give the control log.
    pub fn control_observer(&self) -> Arc<dyn LogObserver> {
        Arc::new(self.sink.clone())
    }

    /// Starts observing the frames of `source` on a dedicated thread. Once only.
    pub fn observe_frames(&mut self, source: impl FrameSource) -> io::Result<()> {
        if self.frames.is_some() {
            return Ok(());
        }
        let sink = self.sink.clone();
        let stop = self.stop_frames.clone();
        self.frames = Some(
            std::thread::Builder::new()
                .name("roadpilot-recorder-frames".into())
                .spawn(move || observe_frames(source, sink, stop))?,
        );
        Ok(())
    }

    /// Stops observing, writes out everything queued and the end record. `None` if the writer
    /// did not finish within `timeout` (it then keeps running detached).
    pub fn finish(mut self, timeout: Duration) -> Option<Summary> {
        self.stop(timeout)
    }

    fn stop(&mut self, timeout: Duration) -> Option<Summary> {
        self.stop_frames.store(true, SeqCst);
        if let Some(frames) = self.frames.take() {
            let _ = join_within(frames, timeout);
        }
        let writer = self.writer.take()?;
        self.sink.shared.stopping.store(true, SeqCst);
        writer.thread().unpark();
        let summary = join_within(writer, timeout);
        if summary.is_none() {
            eprintln!("RoadPilot: telemetry recording did not finish within {timeout:?}");
        }
        summary
    }
}

impl Drop for Recorder {
    fn drop(&mut self) {
        let _ = self.stop(FINISH_TIMEOUT);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::control::freshness::Discontinuity;
    use crate::control::log::{ControlLog, DecisionEvent, Entry, TimingEvent};
    use crate::control::supervisor::{Reason, State, Transition};
    use crate::control::vehicle::test_support::{paused_frame, slow_frame};
    use roadpilot_telemetry_client::TelemetryFrame;
    use std::sync::Mutex;

    /// In-memory output shared with the test.
    #[derive(Clone, Default)]
    struct Output(Arc<Mutex<Vec<u8>>>);

    impl Write for Output {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    impl Output {
        fn lines(&self) -> Vec<Value> {
            String::from_utf8(self.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).expect("every line is one JSON object"))
                .collect()
        }
    }

    /// Fails the write calls whose index (from 0) is in `fail`; `None` fails all.
    struct Failing {
        calls: usize,
        fail: Option<Vec<usize>>,
        inner: Output,
    }

    impl Write for Failing {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            let call = self.calls;
            self.calls += 1;
            if self.fail.as_ref().is_none_or(|f| f.contains(&call)) {
                return Err(io::Error::other("disk full"));
            }
            self.inner.write(buf)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    fn of_type<'a>(lines: &'a [Value], kind: &str) -> Vec<&'a Value> {
        lines.iter().filter(|l| l["type"] == kind).collect()
    }

    fn decision(n: u64) -> Observed {
        Observed::Decision(Entry {
            n,
            at: Duration::from_millis(n),
            event: DecisionEvent::FeedLost,
        })
    }

    fn received(frame: TelemetryFrame) -> ReceivedTelemetryFrame {
        ReceivedTelemetryFrame {
            frame,
            dropped_fields: Vec::new(),
            received_at: Instant::now(),
            received_qpc: None,
        }
    }

    fn temp_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir()
            .join(format!("roadpilot-recorder-test-{unique}"))
            .join(name)
    }

    // ---- on / off ----

    #[test]
    fn without_a_value_there_is_no_recorder_and_no_file() {
        assert!(Recorder::from_value(None).is_none());
        assert!(Recorder::from_value(Some(OsString::new())).is_none());
    }

    #[test]
    fn with_a_value_a_new_file_is_recorded_and_never_overwritten() {
        let path = temp_path("drive.jsonl");
        let recorder = Recorder::from_value(Some(path.clone().into())).expect("recording");
        assert_eq!(recorder.path(), Some(path.as_path()));
        recorder.control_observer().observe(decision(0));
        let summary = recorder.finish(FINISH_TIMEOUT).expect("finished");
        assert!(summary.complete, "{summary:?}");
        let text = std::fs::read_to_string(&path).unwrap();
        let types: Vec<String> = text
            .lines()
            .map(|l| serde_json::from_str::<Value>(l).unwrap()["type"].to_string())
            .collect();
        assert_eq!(types, ["\"start\"", "\"control\"", "\"end\""]);
        // A second recorder on the same path is refused; the first file is untouched.
        assert!(Recorder::from_value(Some(path.clone().into())).is_none());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), text);
        let _ = std::fs::remove_dir_all(path.parent().unwrap());
    }

    // ---- format ----

    #[test]
    fn every_line_is_a_json_object_with_type_and_times() {
        let out = Output::default();
        let recorder = Recorder::with_output(out.clone(), 64, WRITER_POLL).unwrap();
        recorder.sink.push(Item::Frame {
            received: Box::new(received(slow_frame(7, 1, 1_000))),
            sequence_gap: None,
            session_changed: false,
        });
        recorder.control_observer().observe(decision(0));
        recorder.finish(FINISH_TIMEOUT).unwrap();
        let lines = out.lines();
        assert_eq!(lines.first().unwrap()["type"], "start");
        assert_eq!(lines.first().unwrap()["formatVersion"], FORMAT_VERSION);
        assert_eq!(lines.last().unwrap()["type"], "end");
        for line in &lines {
            assert!(line.is_object());
            assert!(line["type"].is_string(), "{line}");
            assert!(line["monoUs"].is_i64(), "{line}");
            assert!(
                line["unixUs"].as_i64().unwrap() > 1_700_000_000_000_000,
                "{line}"
            );
        }
        let frame = of_type(&lines, "frame")[0];
        assert_eq!(frame["session"], 7);
        assert_eq!(frame["sequence"], 1);
        assert_eq!(frame["simulationTimeUs"], 1_000);
        assert_eq!(frame["pluginState"], "running");
        assert_eq!(frame["paused"], false);
        assert_eq!(frame["frame"]["truck"]["speedMps"], 3.0);
    }

    // ---- frames: session, sequence, pause ----

    struct TestFeed(Arc<Mutex<watch::Receiver<Option<ReceivedTelemetryFrame>>>>);

    impl FrameSource for TestFeed {
        fn receiver(&self) -> watch::Receiver<Option<ReceivedTelemetryFrame>> {
            self.0.lock().unwrap().clone()
        }
    }

    fn send(tx: &watch::Sender<Option<ReceivedTelemetryFrame>>, frame: TelemetryFrame) {
        tx.send_replace(Some(received(frame)));
        std::thread::sleep(Duration::from_millis(25));
    }

    #[test]
    fn frames_record_sequence_gaps_session_changes_pause_and_feed_changes() {
        let out = Output::default();
        let mut recorder = Recorder::with_output(out.clone(), 1_024, WRITER_POLL).unwrap();
        let (tx, rx) = watch::channel(None);
        let current = Arc::new(Mutex::new(rx));
        recorder.observe_frames(TestFeed(current.clone())).unwrap();
        std::thread::sleep(Duration::from_millis(60));
        send(&tx, slow_frame(7, 1, 16_000));
        send(&tx, slow_frame(7, 2, 32_000));
        send(&tx, slow_frame(7, 5, 80_000)); // 3 and 4 never arrived
        send(&tx, paused_frame(7, 6, 80_000));
        send(&tx, paused_frame(7, 7, 80_000));
        send(&tx, slow_frame(7, 8, 96_000)); // resumed
        send(&tx, slow_frame(9, 1, 1_000)); // the game reloaded the plugin
        // The engine restarts its pipe server: a new channel replaces the old one.
        let (tx2, rx2) = watch::channel(None);
        *current.lock().unwrap() = rx2;
        drop(tx);
        std::thread::sleep(Duration::from_millis(150));
        send(&tx2, slow_frame(9, 2, 17_000));
        let summary = recorder.finish(FINISH_TIMEOUT).unwrap();
        assert!(summary.complete, "{summary:?}");

        let lines = out.lines();
        let frames = of_type(&lines, "frame");
        let seen: Vec<(u64, u64, bool, Value, bool)> = frames
            .iter()
            .map(|f| {
                (
                    f["session"].as_u64().unwrap(),
                    f["sequence"].as_u64().unwrap(),
                    f["paused"].as_bool().unwrap(),
                    f["sequenceGap"].clone(),
                    f["sessionChanged"].as_bool().unwrap(),
                )
            })
            .collect();
        assert_eq!(
            seen,
            [
                (7, 1, false, Value::Null, false),
                (7, 2, false, Value::Null, false),
                (7, 5, false, json!(2), false),
                (7, 6, true, Value::Null, false),
                (7, 7, true, Value::Null, false),
                (7, 8, false, Value::Null, false),
                (9, 1, false, Value::Null, true),
                (9, 2, false, Value::Null, false),
            ]
        );
        assert_eq!(frames[3]["pluginState"], "paused");
        let feed: Vec<&Value> = of_type(&lines, "feed")
            .iter()
            .map(|f| &f["event"])
            .collect();
        assert_eq!(feed, ["attached", "lost", "attached"]);
        assert_eq!(summary.queued.frames, 8);
        assert_eq!(summary.written.frames, 8);
    }

    // ---- QPC timing ----

    #[cfg(windows)]
    #[test]
    fn frames_record_their_qpc_timing_or_why_it_is_invalid() {
        use roadpilot_telemetry_client::qpc;
        let frequency = qpc::frequency().unwrap();
        let now = qpc::now().unwrap();
        let stamped = |produced: u64, sent: u64| {
            let mut frame = slow_frame(7, 1, 1_000);
            frame.produced_qpc = Some(produced);
            frame.sent_qpc = Some(sent);
            frame.qpc_frequency = Some(frequency);
            ReceivedTelemetryFrame {
                received_qpc: Some(now),
                ..received(frame)
            }
        };
        let out = Output::default();
        let recorder = Recorder::with_output(out.clone(), 64, WRITER_POLL).unwrap();
        for frame in [
            // Produced 10 ms and sent 1 ms before it was received.
            stamped(now - frequency / 100, now - frequency / 1_000),
            // Sent before it was produced: not one timeline.
            stamped(now - 10, now - 20),
            // An older plugin without stamps.
            received({
                let mut old = slow_frame(7, 3, 2_000);
                old.produced_qpc = None;
                old.sent_qpc = None;
                old.qpc_frequency = None;
                old
            }),
        ] {
            recorder.sink.push(Item::Frame {
                received: Box::new(frame),
                sequence_gap: None,
                session_changed: false,
            });
        }
        recorder.finish(FINISH_TIMEOUT).unwrap();
        let lines = out.lines();
        let frames = of_type(&lines, "frame");
        let valid = &frames[0]["timing"];
        assert_eq!(frames[0]["receivedQpc"], now);
        assert_eq!(valid["valid"], true);
        let age = valid["ageAtReceiveUs"].as_u64().unwrap();
        assert!((9_999..=10_000).contains(&age), "{valid}");
        let transport = valid["transportUs"].as_u64().unwrap();
        assert!((999..=1_000).contains(&transport), "{valid}");
        assert_eq!(frames[1]["timing"]["valid"], false);
        assert!(
            frames[1]["timing"]["error"]
                .as_str()
                .unwrap()
                .starts_with("NotMonotonic")
        );
        assert_eq!(frames[2]["timing"]["valid"], false);
        assert_eq!(frames[2]["timing"]["error"], "Missing(Produced)");
        assert_eq!(lines[0]["formatVersion"], 2);
    }

    // ---- control records ----

    #[test]
    fn freshness_and_supervisor_records_are_written_completely() {
        let out = Output::default();
        let recorder = Recorder::with_output(out.clone(), 4_096, WRITER_POLL).unwrap();
        let t0 = Instant::now();
        let log = ControlLog::with_observer(t0, Some(recorder.control_observer()));
        // More decisions than the in-memory ring keeps: the recording keeps all of them.
        for i in 0..300u64 {
            log.decision(
                t0 + Duration::from_millis(i),
                DecisionEvent::Epoch {
                    epoch: i,
                    cause: Discontinuity::Paused,
                },
            );
        }
        log.decision(
            t0,
            DecisionEvent::Transition(Transition {
                from: State::Active,
                to: State::Fault,
                reason: Reason::ManualDisarm,
            }),
        );
        log.timing(
            t0,
            TimingEvent::Late {
                lateness: Duration::from_millis(12),
            },
        );
        log.assessment(
            t0 + Duration::from_millis(500),
            Assessment::Unusable(Unusable::Stale {
                age: Duration::from_millis(180),
            }),
        );
        log.assessment(t0, Assessment::Unusable(Unusable::Paused));
        assert!(
            log.snapshot().dropped.decisions > 0,
            "the ring dropped some"
        );
        recorder.finish(FINISH_TIMEOUT).unwrap();

        let lines = out.lines();
        let control = of_type(&lines, "control");
        let decisions: Vec<&&Value> = control
            .iter()
            .filter(|c| c["category"] == "decision")
            .collect();
        assert_eq!(decisions.len(), 301);
        let positions: Vec<u64> = decisions.iter().map(|d| d["n"].as_u64().unwrap()).collect();
        assert_eq!(positions, (0..301).collect::<Vec<_>>());
        assert_eq!(decisions[299]["entry"]["event"], "epoch");
        assert_eq!(decisions[299]["entry"]["cause"], "paused");
        assert_eq!(decisions[299]["atUs"], 299_000);
        let transition = &decisions[300]["entry"];
        assert_eq!(transition["event"], "transition");
        assert_eq!(transition["from"], "active");
        assert_eq!(transition["to"], "fault");
        let timing = control.iter().find(|c| c["category"] == "timing").unwrap();
        assert_eq!(timing["entry"]["event"], "late");
        let assessments: Vec<&&Value> = control
            .iter()
            .filter(|c| c["category"] == "assessment")
            .collect();
        assert_eq!(assessments[0]["freshness"], "stale");
        assert_eq!(assessments[0]["ageUs"], 180_000);
        assert_eq!(assessments[0]["atUs"], 500_000);
        assert_eq!(assessments[1]["freshness"], "paused");
    }

    // ---- losses ----

    #[test]
    fn a_full_queue_drops_without_blocking_and_reports_the_loss() {
        let out = Output::default();
        let (sink, writer) = channel(out.clone(), 4);
        let started = Instant::now();
        for n in 0..10 {
            sink.observe(decision(n));
        }
        assert!(
            started.elapsed() < Duration::from_millis(100),
            "never waits"
        );
        sink.shared.stopping.store(true, SeqCst);
        let summary = writer.run(WRITER_POLL);
        assert_eq!(summary.queued.control, 4);
        assert_eq!(summary.written.control, 4);
        assert_eq!(summary.queue_full.control, 6);
        assert!(!summary.complete);
        let lines = out.lines();
        let loss = of_type(&lines, "loss");
        assert_eq!(loss.len(), 1);
        assert_eq!(loss[0]["queueFull"]["control"], 6);
        assert_eq!(loss[0]["queueFullSinceLast"]["control"], 6);
        let end = lines.last().unwrap();
        assert_eq!(end["type"], "end");
        assert_eq!(end["complete"], false);
        assert_eq!(end["queueFull"]["control"], 6);
    }

    #[test]
    fn a_failed_write_is_counted_and_reported_once_writing_works_again() {
        let out = Output::default();
        // Call 0 is the start line; call 1, the first batch, fails.
        let failing = Failing {
            calls: 0,
            fail: Some(vec![1]),
            inner: out.clone(),
        };
        let (sink, writer) = channel(failing, 64);
        for n in 0..3 {
            sink.observe(decision(n));
        }
        sink.shared.stopping.store(true, SeqCst);
        let summary = writer.run(WRITER_POLL);
        assert_eq!(summary.write_failed, 3);
        assert_eq!(summary.first_write_error.as_deref(), Some("disk full"));
        assert!(!summary.complete);
        let lines = out.lines();
        assert_eq!(lines[0]["type"], "start");
        let loss = of_type(&lines, "loss");
        assert_eq!(loss.len(), 1);
        assert_eq!(loss[0]["writeFailed"], 3);
        assert_eq!(loss[0]["firstWriteError"], "disk full");
        assert_eq!(lines.last().unwrap()["writeFailed"], 3);
        assert_eq!(lines.last().unwrap()["complete"], false);
    }

    #[test]
    fn an_unwritable_output_never_affects_the_sender() {
        let failing = Failing {
            calls: 0,
            fail: None,
            inner: Output::default(),
        };
        let recorder = Recorder::with_output(failing, 8, WRITER_POLL).unwrap();
        let observer = recorder.control_observer();
        let started = Instant::now();
        for n in 0..1_000 {
            observer.observe(decision(n));
        }
        assert!(started.elapsed() < Duration::from_millis(500));
        let summary = recorder.finish(FINISH_TIMEOUT).unwrap();
        assert!(summary.write_failed > 0);
        assert_eq!(summary.written, Counts::default());
        assert_eq!(
            summary.queued.control + summary.queue_full.control,
            1_000,
            "every record is accounted for"
        );
        assert!(!summary.complete);
    }

    // ---- shutdown ----

    #[test]
    fn finishing_writes_out_the_whole_queue_and_then_rejects_records() {
        let out = Output::default();
        // A long poll: only the explicit finish wakes the writer.
        let recorder = Recorder::with_output(out.clone(), 4_096, Duration::from_secs(30)).unwrap();
        let observer = recorder.control_observer();
        let sink = recorder.sink.clone();
        for n in 0..2_000 {
            observer.observe(decision(n));
        }
        let started = Instant::now();
        let summary = recorder.finish(FINISH_TIMEOUT).unwrap();
        assert!(
            started.elapsed() < Duration::from_secs(2),
            "finish wakes the writer"
        );
        assert!(summary.complete, "{summary:?}");
        assert_eq!(summary.written.control, 2_000);
        let lines = out.lines();
        assert_eq!(of_type(&lines, "control").len(), 2_000);
        assert_eq!(lines.last().unwrap()["type"], "end");
        assert_eq!(lines.last().unwrap()["complete"], true);
        // After the stop a record is refused and counted, never queued unwritten.
        sink.observe(decision(9_999));
        assert_eq!(sink.shared.rejected_after_stop.load(SeqCst), 1);
        assert_eq!(out.lines().len(), lines.len());
    }

    #[test]
    fn dropping_the_recorder_finishes_it() {
        let out = Output::default();
        {
            let recorder = Recorder::with_output(out.clone(), 64, Duration::from_secs(30)).unwrap();
            recorder.control_observer().observe(decision(0));
        }
        let lines = out.lines();
        assert_eq!(lines.last().unwrap()["type"], "end");
        assert_eq!(lines.last().unwrap()["complete"], true);
    }

    // ---- isolation ----

    #[test]
    fn the_recorder_never_touches_the_input_plugin() {
        let source = include_str!("recorder.rs");
        let input_pipe = ["roadpilot", "-input"].concat();
        let pipe_prefix = ["\\\\", ".\\", "pipe"].concat();
        for (number, line) in source.lines().enumerate() {
            let code = line.split("//").next().unwrap_or("");
            assert!(
                !code.contains(input_pipe.as_str()) && !code.contains(pipe_prefix.as_str()),
                "recorder.rs:{} names a pipe: {line}",
                number + 1
            );
        }
    }
}
