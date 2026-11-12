//! Safety supervisor: the only authority that decides whether control output is permitted.
//!
//! Pure and deterministic: the supervisor owns no clock, no pipe and no UI. Every decision
//! comes from the two inputs it is given:
//!
//! * the [`Assessment`] of the freshness monitor (validated, fresh, settled vehicle state, or
//!   the reason there is none), and
//! * explicit [`Command`]s.
//!
//! # States
//!
//! ```text
//!            Arm (usable state, speed within cap)
//!  Disabled ------------------------------------> Armed
//!     ^  ^                                          |  |
//!     |  | safety event / Disarm                    |  | Activate (state still matches)
//!     |  +------------------------------------------+  v
//!     |  <---------------- Disarm ------------------ Active
//!     |                                                |
//!     | ResetFault                  safety event       |
//!     +------------------ Fault <----------------------+
//! ```
//!
//! * **Disabled** is the initial state. No output is permitted.
//! * **Armed** means the operator armed control for one specific vehicle epoch, session and
//!   game. Output is still not permitted.
//! * **Active** is the only state in which output is permitted ([`Supervisor::permits_output`]).
//! * **Fault** is entered when a safety event occurs while Active. It inhibits output, ignores
//!   telemetry, and is left only by an explicit [`Command::ResetFault`], which leads to
//!   Disabled; control then needs a new manual arm.
//!
//! # Rules
//!
//! * Armed is reachable only through [`Command::Arm`]. Nothing ever re-arms or re-activates
//!   automatically, so a reconnect, a restart or a recovered telemetry stream cannot restore
//!   control.
//! * Arming binds the supervisor to the epoch, session and game of the sample it was armed
//!   with. A sample of any other epoch is a safety event, so an old epoch can never authorize
//!   activation.
//! * A safety event while Armed disarms to Disabled; while Active it ends in Fault. Safety
//!   events are evaluated before every command except [`Command::Disarm`], so a safety event
//!   always wins over an activation request.
//! * [`Command::Disarm`] is processed first and is always accepted.
//! * Every transition carries a structured [`Reason`].
//!
//! The supervisor never sends anything to the game.

use super::freshness::{Assessment, Sample, Unusable};
use super::vehicle::InvalidFrame;
use roadpilot_telemetry_client::GameId;
use std::time::Duration;

/// Default test speed cap. Deliberately low; raising it is a conscious configuration act.
pub const DEFAULT_SPEED_CAP_MPS: f32 = 5.0;
/// Highest configurable test speed cap (90 km/h).
pub const MAX_SPEED_CAP_MPS: f32 = 25.0;

/// The speed cap was not a finite number in `(0, MAX_SPEED_CAP_MPS]`.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidSpeedCap;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SupervisorConfig {
    speed_cap_mps: f32,
}

impl SupervisorConfig {
    pub fn new(speed_cap_mps: f32) -> Result<Self, InvalidSpeedCap> {
        if speed_cap_mps.is_finite() && speed_cap_mps > 0.0 && speed_cap_mps <= MAX_SPEED_CAP_MPS {
            Ok(Self { speed_cap_mps })
        } else {
            Err(InvalidSpeedCap)
        }
    }

    pub fn speed_cap_mps(&self) -> f32 {
        self.speed_cap_mps
    }
}

impl Default for SupervisorConfig {
    fn default() -> Self {
        Self {
            speed_cap_mps: DEFAULT_SPEED_CAP_MPS,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum State {
    Disabled,
    Armed,
    Active,
    Fault,
}

/// Operator requests. They carry no vehicle data; the current assessment is passed alongside.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Command {
    Arm,
    Activate,
    /// Always accepted, in every state.
    Disarm,
    /// Leaves Fault for Disabled. Does not arm.
    ResetFault,
}

/// A condition that makes continuing unsafe. Speeds are in m/s.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum SafetyEvent {
    /// No frame has ever been accepted (telemetry not connected).
    TelemetryUnavailable,
    Paused,
    StaleTelemetry {
        age: Duration,
    },
    SimulationStalled {
        stalled_for: Duration,
    },
    /// A new epoch began and has not settled.
    NotSettled,
    InvalidVehicleState(InvalidFrame),
    /// The vehicle epoch differs from the one control was armed for (reconnect, interruption
    /// or any other discontinuity).
    EpochChanged {
        armed: u64,
        current: u64,
    },
    SessionChanged {
        armed: u64,
        current: u64,
    },
    GameChanged {
        armed: GameId,
        current: GameId,
    },
    SpeedCapExceeded {
        speed_mps: f32,
        cap_mps: f32,
    },
}

/// Why a transition happened.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Reason {
    ManualArm,
    ManualActivate,
    ManualDisarm,
    FaultReset,
    Safety(SafetyEvent),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transition {
    pub from: State,
    pub to: State,
    pub reason: Reason,
}

/// Why a command was not carried out.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Rejection {
    /// Arming needs a usable vehicle state.
    NotReady(Unusable),
    /// Arming above the speed cap.
    SpeedCapExceeded {
        speed_mps: f32,
        cap_mps: f32,
    },
    AlreadyArmed,
    /// Activation needs the Armed state.
    NotArmed,
    /// A fault must be reset before arming.
    FaultNotReset,
    NotInFault,
    /// A safety event occurred while the command was processed; the transition it caused is
    /// reported in [`Response::transition`].
    Safety(SafetyEvent),
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Response {
    pub result: Result<(), Rejection>,
    /// The state change caused while processing the command, if any (including a safety
    /// transition that preceded a rejected command).
    pub transition: Option<Transition>,
}

/// What control was armed for.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Binding {
    epoch: u64,
    session: u64,
    game: GameId,
}

#[derive(Debug)]
pub struct Supervisor {
    config: SupervisorConfig,
    state: State,
    binding: Option<Binding>,
    last_transition: Option<Transition>,
}

impl Supervisor {
    pub fn new(config: SupervisorConfig) -> Self {
        Self {
            config,
            state: State::Disabled,
            binding: None,
            last_transition: None,
        }
    }

    pub fn state(&self) -> State {
        self.state
    }

    /// True only while Active. Everything that produces output must check this first.
    pub fn permits_output(&self) -> bool {
        self.state == State::Active
    }

    pub fn config(&self) -> SupervisorConfig {
        self.config
    }

    pub fn last_transition(&self) -> Option<Transition> {
        self.last_transition
    }

    fn transition(&mut self, to: State, reason: Reason) -> Transition {
        let t = Transition {
            from: self.state,
            to,
            reason,
        };
        self.state = to;
        if to != State::Armed && to != State::Active {
            self.binding = None;
        }
        self.last_transition = Some(t);
        t
    }

    /// The safety event the assessment represents for control bound to `binding`, if any.
    fn safety_event(&self, binding: &Binding, assessment: &Assessment) -> Option<SafetyEvent> {
        let sample: &Sample = match assessment {
            Assessment::Unusable(u) => {
                return Some(match *u {
                    Unusable::NoFrame => SafetyEvent::TelemetryUnavailable,
                    Unusable::Invalid(reason) => SafetyEvent::InvalidVehicleState(reason),
                    Unusable::Stale { age } => SafetyEvent::StaleTelemetry { age },
                    Unusable::Paused => SafetyEvent::Paused,
                    Unusable::SimulationStalled { stalled_for } => {
                        SafetyEvent::SimulationStalled { stalled_for }
                    }
                    Unusable::Settling => SafetyEvent::NotSettled,
                });
            }
            Assessment::Usable(sample) => sample,
        };
        let id = sample.state.identity;
        if id.session != binding.session {
            Some(SafetyEvent::SessionChanged {
                armed: binding.session,
                current: id.session,
            })
        } else if id.game != binding.game {
            Some(SafetyEvent::GameChanged {
                armed: binding.game,
                current: id.game,
            })
        } else if sample.epoch != binding.epoch {
            Some(SafetyEvent::EpochChanged {
                armed: binding.epoch,
                current: sample.epoch,
            })
        } else if self.over_cap(sample) {
            Some(SafetyEvent::SpeedCapExceeded {
                speed_mps: sample.state.speed_mps,
                cap_mps: self.config.speed_cap_mps,
            })
        } else {
            None
        }
    }

    fn over_cap(&self, sample: &Sample) -> bool {
        sample.state.speed_mps.abs() > self.config.speed_cap_mps
    }

    /// Applies safety evaluation for Armed and Active. Call it at every control tick.
    /// Returns the transition it caused, if any. Disabled and Fault never change here.
    pub fn update(&mut self, assessment: &Assessment) -> Option<Transition> {
        self.evaluate(assessment).map(|(t, _)| t)
    }

    fn evaluate(&mut self, assessment: &Assessment) -> Option<(Transition, SafetyEvent)> {
        let (binding, to) = match (self.state, self.binding) {
            (State::Armed, Some(b)) => (b, State::Disabled),
            (State::Active, Some(b)) => (b, State::Fault),
            // Armed or Active without a binding cannot happen; fail closed if it ever does.
            (State::Armed | State::Active, None) => {
                let event = SafetyEvent::TelemetryUnavailable;
                let to = if self.state == State::Active {
                    State::Fault
                } else {
                    State::Disabled
                };
                return Some((self.transition(to, Reason::Safety(event)), event));
            }
            (State::Disabled | State::Fault, _) => return None,
        };
        let event = self.safety_event(&binding, assessment)?;
        Some((self.transition(to, Reason::Safety(event)), event))
    }

    /// Processes one operator command against the current assessment.
    pub fn command(&mut self, command: Command, assessment: &Assessment) -> Response {
        // Disarm comes first and is always accepted.
        if command == Command::Disarm {
            let transition = match self.state {
                State::Armed | State::Active => {
                    Some(self.transition(State::Disabled, Reason::ManualDisarm))
                }
                // Disabled is already disarmed; Fault stays until it is explicitly reset.
                State::Disabled | State::Fault => None,
            };
            return Response {
                result: Ok(()),
                transition,
            };
        }

        // Safety events take priority over every other command.
        if let Some((transition, event)) = self.evaluate(assessment) {
            return Response {
                result: Err(Rejection::Safety(event)),
                transition: Some(transition),
            };
        }

        match (command, self.state) {
            (Command::Arm, State::Disabled) => match assessment {
                Assessment::Unusable(reason) => Response {
                    result: Err(Rejection::NotReady(*reason)),
                    transition: None,
                },
                Assessment::Usable(sample) if self.over_cap(sample) => Response {
                    result: Err(Rejection::SpeedCapExceeded {
                        speed_mps: sample.state.speed_mps,
                        cap_mps: self.config.speed_cap_mps,
                    }),
                    transition: None,
                },
                Assessment::Usable(sample) => {
                    self.binding = Some(Binding {
                        epoch: sample.epoch,
                        session: sample.state.identity.session,
                        game: sample.state.identity.game,
                    });
                    Response {
                        result: Ok(()),
                        transition: Some(self.transition(State::Armed, Reason::ManualArm)),
                    }
                }
            },
            (Command::Arm, State::Armed | State::Active) => Response {
                result: Err(Rejection::AlreadyArmed),
                transition: None,
            },
            (Command::Arm, State::Fault) => Response {
                result: Err(Rejection::FaultNotReset),
                transition: None,
            },
            // The assessment was just checked against the binding, so it is usable, belongs
            // to the armed epoch and is within the speed cap.
            (Command::Activate, State::Armed) => Response {
                result: Ok(()),
                transition: Some(self.transition(State::Active, Reason::ManualActivate)),
            },
            (Command::Activate, _) => Response {
                result: Err(Rejection::NotArmed),
                transition: None,
            },
            (Command::ResetFault, State::Fault) => Response {
                result: Ok(()),
                transition: Some(self.transition(State::Disabled, Reason::FaultReset)),
            },
            (Command::ResetFault, _) => Response {
                result: Err(Rejection::NotInFault),
                transition: None,
            },
            (Command::Disarm, _) => unreachable!("handled above"),
        }
    }
}

impl Default for Supervisor {
    fn default() -> Self {
        Self::new(SupervisorConfig::default())
    }
}

#[cfg(test)]
mod tests {
    use super::super::vehicle::{FrameIdentity, VehicleState, test_support::running_frame};
    use super::*;

    fn ms(n: u64) -> Duration {
        Duration::from_millis(n)
    }

    fn usable_with(epoch: u64, session: u64, game: GameId, speed: f32) -> Assessment {
        let mut frame = running_frame(session, 10, 1_000_000);
        frame.game = game;
        frame.truck.as_mut().unwrap().speed_mps = Some(speed);
        let state = VehicleState::from_frame(&frame).unwrap();
        assert_eq!(
            state.identity,
            FrameIdentity {
                game,
                session,
                sequence: 10,
                simulation_time_us: 1_000_000
            }
        );
        Assessment::Usable(Sample {
            state,
            epoch,
            age: ms(10),
        })
    }

    /// Usable state of epoch 1, session 7, ETS2 at 3 m/s.
    fn ok() -> Assessment {
        usable_with(1, 7, GameId::Ets2, 3.0)
    }

    fn armed() -> Supervisor {
        let mut s = Supervisor::default();
        assert!(s.command(Command::Arm, &ok()).result.is_ok());
        s
    }

    fn active() -> Supervisor {
        let mut s = armed();
        assert!(s.command(Command::Activate, &ok()).result.is_ok());
        s
    }

    fn unusable_cases() -> Vec<(Unusable, SafetyEvent)> {
        vec![
            (Unusable::NoFrame, SafetyEvent::TelemetryUnavailable),
            (Unusable::Paused, SafetyEvent::Paused),
            (
                Unusable::Stale { age: ms(400) },
                SafetyEvent::StaleTelemetry { age: ms(400) },
            ),
            (
                Unusable::SimulationStalled {
                    stalled_for: ms(300),
                },
                SafetyEvent::SimulationStalled {
                    stalled_for: ms(300),
                },
            ),
            (Unusable::Settling, SafetyEvent::NotSettled),
            (
                Unusable::Invalid(InvalidFrame::MissingField("placement")),
                SafetyEvent::InvalidVehicleState(InvalidFrame::MissingField("placement")),
            ),
            (
                Unusable::Invalid(InvalidFrame::MissingSession),
                SafetyEvent::InvalidVehicleState(InvalidFrame::MissingSession),
            ),
        ]
    }

    /// Every non-telemetry-loss safety event, with the assessment that causes it.
    fn identity_cases() -> Vec<(Assessment, SafetyEvent)> {
        vec![
            (
                usable_with(2, 7, GameId::Ets2, 3.0),
                SafetyEvent::EpochChanged {
                    armed: 1,
                    current: 2,
                },
            ),
            (
                usable_with(1, 8, GameId::Ets2, 3.0),
                SafetyEvent::SessionChanged {
                    armed: 7,
                    current: 8,
                },
            ),
            (
                usable_with(1, 7, GameId::Ats, 3.0),
                SafetyEvent::GameChanged {
                    armed: GameId::Ets2,
                    current: GameId::Ats,
                },
            ),
            (
                usable_with(1, 7, GameId::Ets2, 5.5),
                SafetyEvent::SpeedCapExceeded {
                    speed_mps: 5.5,
                    cap_mps: 5.0,
                },
            ),
        ]
    }

    fn safety_cases() -> Vec<(Assessment, SafetyEvent)> {
        let mut cases: Vec<_> = unusable_cases()
            .into_iter()
            .map(|(u, e)| (Assessment::Unusable(u), e))
            .collect();
        cases.extend(identity_cases());
        cases
    }

    #[test]
    fn starts_disabled_and_permits_nothing() {
        let s = Supervisor::default();
        assert_eq!(s.state(), State::Disabled);
        assert!(!s.permits_output());
        assert_eq!(s.last_transition(), None);
    }

    #[test]
    fn nothing_arms_automatically() {
        let mut s = Supervisor::default();
        for _ in 0..100 {
            assert_eq!(s.update(&ok()), None);
        }
        assert_eq!(s.state(), State::Disabled);
    }

    #[test]
    fn arming_a_usable_state_arms_with_a_reason() {
        let mut s = Supervisor::default();
        let r = s.command(Command::Arm, &ok());
        assert_eq!(r.result, Ok(()));
        assert_eq!(
            r.transition,
            Some(Transition {
                from: State::Disabled,
                to: State::Armed,
                reason: Reason::ManualArm
            })
        );
        assert_eq!(s.state(), State::Armed);
        assert!(!s.permits_output(), "armed is not active");
        assert_eq!(s.last_transition(), r.transition);
    }

    #[test]
    fn arming_without_a_usable_state_is_refused_for_every_reason() {
        for (unusable, _) in unusable_cases() {
            let mut s = Supervisor::default();
            let r = s.command(Command::Arm, &Assessment::Unusable(unusable));
            assert_eq!(r.result, Err(Rejection::NotReady(unusable)));
            assert_eq!(r.transition, None);
            assert_eq!(s.state(), State::Disabled);
        }
    }

    #[test]
    fn arming_above_the_speed_cap_is_refused_but_at_the_cap_is_allowed() {
        let mut s = Supervisor::default();
        let r = s.command(Command::Arm, &usable_with(1, 7, GameId::Ets2, 5.01));
        assert_eq!(
            r.result,
            Err(Rejection::SpeedCapExceeded {
                speed_mps: 5.01,
                cap_mps: 5.0
            })
        );
        assert_eq!(s.state(), State::Disabled);
        let r = s.command(Command::Arm, &usable_with(1, 7, GameId::Ets2, -5.01));
        assert!(
            r.result.is_err(),
            "reversing faster than the cap counts too"
        );
        assert!(
            s.command(Command::Arm, &usable_with(1, 7, GameId::Ets2, 5.0))
                .result
                .is_ok()
        );
    }

    #[test]
    fn activation_from_armed_makes_output_permitted() {
        let mut s = armed();
        let r = s.command(Command::Activate, &ok());
        assert_eq!(r.result, Ok(()));
        assert_eq!(
            r.transition,
            Some(Transition {
                from: State::Armed,
                to: State::Active,
                reason: Reason::ManualActivate
            })
        );
        assert!(s.permits_output());
    }

    #[test]
    fn activation_requires_arming_first() {
        let mut s = Supervisor::default();
        let r = s.command(Command::Activate, &ok());
        assert_eq!(r.result, Err(Rejection::NotArmed));
        assert_eq!(r.transition, None);
        assert_eq!(s.state(), State::Disabled);
        assert!(!s.permits_output());
    }

    #[test]
    fn a_healthy_stream_keeps_armed_and_active_unchanged() {
        let mut s = active();
        for _ in 0..100 {
            assert_eq!(s.update(&ok()), None);
        }
        assert_eq!(s.state(), State::Active);
        let mut s = armed();
        assert_eq!(s.update(&ok()), None);
        assert_eq!(s.state(), State::Armed);
    }

    #[test]
    fn every_safety_event_disarms_armed_to_disabled_with_its_reason() {
        for (assessment, event) in safety_cases() {
            let mut s = armed();
            let t = s.update(&assessment).expect("must transition");
            assert_eq!(
                t,
                Transition {
                    from: State::Armed,
                    to: State::Disabled,
                    reason: Reason::Safety(event)
                }
            );
            assert_eq!(s.state(), State::Disabled);
            assert!(!s.permits_output());
        }
    }

    #[test]
    fn every_safety_event_ends_active_in_fault_with_its_reason() {
        for (assessment, event) in safety_cases() {
            let mut s = active();
            let t = s.update(&assessment).expect("must transition");
            assert_eq!(
                t,
                Transition {
                    from: State::Active,
                    to: State::Fault,
                    reason: Reason::Safety(event)
                },
                "{event:?}"
            );
            assert_eq!(s.state(), State::Fault);
            assert!(!s.permits_output());
        }
    }

    #[test]
    fn pause_stale_invalid_session_game_and_speed_are_each_covered() {
        let pairs = [
            (Unusable::Paused, "Paused"),
            (Unusable::Stale { age: ms(400) }, "StaleTelemetry"),
            (
                Unusable::Invalid(InvalidFrame::NonFiniteValue("truck.speedMps")),
                "InvalidVehicleState",
            ),
        ];
        for (unusable, name) in pairs {
            let mut s = active();
            s.update(&Assessment::Unusable(unusable));
            assert_eq!(s.state(), State::Fault);
            let dbg = format!("{:?}", s.last_transition().unwrap().reason);
            assert!(dbg.contains(name), "{dbg}");
        }
        for (assessment, label) in [
            (usable_with(1, 99, GameId::Ets2, 3.0), "SessionChanged"),
            (usable_with(1, 7, GameId::Ats, 3.0), "GameChanged"),
            (usable_with(1, 7, GameId::Ets2, 9.0), "SpeedCapExceeded"),
        ] {
            let mut s = active();
            s.update(&assessment);
            assert_eq!(s.state(), State::Fault);
            let dbg = format!("{:?}", s.last_transition().unwrap().reason);
            assert!(dbg.contains(label), "{dbg}");
        }
    }

    #[test]
    fn identity_changes_are_reported_most_specific_first() {
        // New session, game and epoch at once: the session is reported.
        let mut s = active();
        s.update(&usable_with(5, 99, GameId::Ats, 20.0));
        assert!(matches!(
            s.last_transition().unwrap().reason,
            Reason::Safety(SafetyEvent::SessionChanged { .. })
        ));
        // New game, epoch and speed with the same session: the game is reported.
        let mut s = active();
        s.update(&usable_with(5, 7, GameId::Ats, 20.0));
        assert!(matches!(
            s.last_transition().unwrap().reason,
            Reason::Safety(SafetyEvent::GameChanged { .. })
        ));
        // New epoch and speed: the epoch is reported.
        let mut s = active();
        s.update(&usable_with(5, 7, GameId::Ets2, 20.0));
        assert!(matches!(
            s.last_transition().unwrap().reason,
            Reason::Safety(SafetyEvent::EpochChanged { .. })
        ));
    }

    #[test]
    fn speed_exactly_at_the_cap_is_allowed_and_above_it_is_not() {
        let mut s = active();
        assert_eq!(s.update(&usable_with(1, 7, GameId::Ets2, 5.0)), None);
        assert!(s.update(&usable_with(1, 7, GameId::Ets2, 5.001)).is_some());
        assert_eq!(s.state(), State::Fault);
        let mut s = active();
        assert!(s.update(&usable_with(1, 7, GameId::Ets2, -6.0)).is_some());
    }

    #[test]
    fn a_custom_speed_cap_applies() {
        let mut s = Supervisor::new(SupervisorConfig::new(10.0).unwrap());
        assert!(
            s.command(Command::Arm, &usable_with(1, 7, GameId::Ets2, 9.0))
                .result
                .is_ok()
        );
        assert_eq!(
            s.update(&usable_with(1, 7, GameId::Ets2, 10.5)).unwrap().to,
            State::Disabled
        );
    }

    #[test]
    fn the_speed_cap_is_validated() {
        assert!(SupervisorConfig::new(0.1).is_ok());
        assert!(SupervisorConfig::new(MAX_SPEED_CAP_MPS).is_ok());
        for bad in [
            0.0,
            -1.0,
            MAX_SPEED_CAP_MPS + 0.1,
            f32::NAN,
            f32::INFINITY,
            f32::NEG_INFINITY,
        ] {
            assert_eq!(SupervisorConfig::new(bad), Err(InvalidSpeedCap), "{bad}");
        }
        assert_eq!(SupervisorConfig::default().speed_cap_mps(), 5.0);
    }

    #[test]
    fn manual_disarm_returns_armed_and_active_to_disabled() {
        for mut s in [armed(), active()] {
            let from = s.state();
            let r = s.command(Command::Disarm, &ok());
            assert_eq!(r.result, Ok(()));
            assert_eq!(
                r.transition,
                Some(Transition {
                    from,
                    to: State::Disabled,
                    reason: Reason::ManualDisarm
                })
            );
            assert!(!s.permits_output());
        }
    }

    #[test]
    fn manual_disarm_is_accepted_in_every_state_and_with_any_telemetry() {
        let mut assessments: Vec<Assessment> = safety_cases().into_iter().map(|(a, _)| a).collect();
        assessments.push(ok());
        for assessment in &assessments {
            for mut s in [Supervisor::default(), armed(), active(), {
                let mut f = active();
                f.update(&Assessment::Unusable(Unusable::Paused));
                f
            }] {
                let before = s.state();
                let r = s.command(Command::Disarm, assessment);
                assert_eq!(r.result, Ok(()), "disarm must always be accepted");
                match before {
                    State::Armed | State::Active => assert_eq!(s.state(), State::Disabled),
                    other => assert_eq!(s.state(), other),
                }
                assert!(!s.permits_output());
            }
        }
    }

    #[test]
    fn disarm_during_a_safety_event_reports_the_manual_disarm() {
        let mut s = active();
        let r = s.command(Command::Disarm, &Assessment::Unusable(Unusable::Paused));
        assert_eq!(s.state(), State::Disabled, "manual disarm, not a fault");
        assert_eq!(r.transition.unwrap().reason, Reason::ManualDisarm);
    }

    #[test]
    fn disarm_in_fault_keeps_the_fault_until_it_is_reset() {
        let mut s = active();
        s.update(&Assessment::Unusable(Unusable::Paused));
        let r = s.command(Command::Disarm, &ok());
        assert_eq!(r.result, Ok(()));
        assert_eq!(r.transition, None);
        assert_eq!(s.state(), State::Fault);
    }

    #[test]
    fn safety_events_take_priority_over_activation_requests() {
        for (assessment, event) in safety_cases() {
            let mut s = armed();
            let r = s.command(Command::Activate, &assessment);
            assert_eq!(r.result, Err(Rejection::Safety(event)), "{event:?}");
            assert_eq!(
                r.transition,
                Some(Transition {
                    from: State::Armed,
                    to: State::Disabled,
                    reason: Reason::Safety(event)
                })
            );
            assert_eq!(s.state(), State::Disabled);
            assert!(!s.permits_output());
        }
    }

    #[test]
    fn a_vehicle_state_of_an_old_epoch_can_never_activate() {
        let mut s = armed(); // bound to epoch 1
        let r = s.command(Command::Activate, &usable_with(2, 7, GameId::Ets2, 3.0));
        assert!(matches!(
            r.result,
            Err(Rejection::Safety(SafetyEvent::EpochChanged {
                armed: 1,
                current: 2
            }))
        ));
        assert!(!s.permits_output());
        // Re-armed at epoch 2, a late sample of epoch 1 must not activate either.
        assert!(
            s.command(Command::Arm, &usable_with(2, 7, GameId::Ets2, 3.0))
                .result
                .is_ok()
        );
        let r = s.command(Command::Activate, &usable_with(1, 7, GameId::Ets2, 3.0));
        assert!(r.result.is_err());
        assert!(!s.permits_output());
    }

    #[test]
    fn activation_while_active_or_in_fault_is_refused() {
        let mut s = active();
        let r = s.command(Command::Activate, &ok());
        assert_eq!(r.result, Err(Rejection::NotArmed));
        assert_eq!(s.state(), State::Active);
        s.update(&Assessment::Unusable(Unusable::Paused));
        let r = s.command(Command::Activate, &ok());
        assert_eq!(r.result, Err(Rejection::NotArmed));
        assert_eq!(s.state(), State::Fault);
    }

    #[test]
    fn a_reconnect_never_restores_active() {
        let mut s = active();
        // The connection drops: stale, then frames resume with a new epoch.
        s.update(&Assessment::Unusable(Unusable::Stale { age: ms(400) }));
        assert_eq!(s.state(), State::Fault);
        for _ in 0..50 {
            assert_eq!(s.update(&usable_with(2, 7, GameId::Ets2, 3.0)), None);
        }
        assert_eq!(
            s.state(),
            State::Fault,
            "telemetry recovering must not clear a fault"
        );
        assert!(!s.permits_output());
    }

    #[test]
    fn a_reconnect_never_restores_armed() {
        let mut s = armed();
        s.update(&Assessment::Unusable(Unusable::Stale { age: ms(400) }));
        assert_eq!(s.state(), State::Disabled);
        for _ in 0..50 {
            assert_eq!(s.update(&usable_with(2, 7, GameId::Ets2, 3.0)), None);
        }
        assert_eq!(s.state(), State::Disabled);
    }

    #[test]
    fn a_reconnect_that_hides_the_interruption_is_still_caught_by_the_epoch() {
        // A control tick that never saw the stale moment still sees the new epoch.
        let mut s = active();
        let t = s.update(&usable_with(2, 7, GameId::Ets2, 3.0)).unwrap();
        assert_eq!(t.to, State::Fault);
        assert!(matches!(
            t.reason,
            Reason::Safety(SafetyEvent::EpochChanged { .. })
        ));
    }

    #[test]
    fn fault_is_sticky_and_ignores_telemetry() {
        let mut s = active();
        s.update(&Assessment::Unusable(Unusable::Paused));
        for (assessment, _) in safety_cases() {
            assert_eq!(s.update(&assessment), None);
        }
        assert_eq!(s.update(&ok()), None);
        assert_eq!(s.state(), State::Fault);
    }

    #[test]
    fn arming_in_fault_is_refused_until_the_fault_is_reset() {
        let mut s = active();
        s.update(&Assessment::Unusable(Unusable::Paused));
        let r = s.command(Command::Arm, &ok());
        assert_eq!(r.result, Err(Rejection::FaultNotReset));
        assert_eq!(s.state(), State::Fault);
    }

    #[test]
    fn a_fault_needs_an_explicit_reset_and_then_a_new_manual_arm() {
        let mut s = active();
        s.update(&Assessment::Unusable(Unusable::Stale { age: ms(400) }));
        assert_eq!(s.state(), State::Fault);

        let r = s.command(Command::ResetFault, &ok());
        assert_eq!(r.result, Ok(()));
        assert_eq!(
            r.transition,
            Some(Transition {
                from: State::Fault,
                to: State::Disabled,
                reason: Reason::FaultReset
            })
        );
        // The reset does not arm, and healthy telemetry does not either.
        assert_eq!(s.state(), State::Disabled);
        assert_eq!(s.update(&usable_with(2, 7, GameId::Ets2, 3.0)), None);
        assert!(!s.permits_output());

        // Activating without arming again is refused.
        let r = s.command(Command::Activate, &usable_with(2, 7, GameId::Ets2, 3.0));
        assert_eq!(r.result, Err(Rejection::NotArmed));
        assert!(!s.permits_output());

        // A deliberate arm on the new epoch, then activation, restores control.
        assert!(
            s.command(Command::Arm, &usable_with(2, 7, GameId::Ets2, 3.0))
                .result
                .is_ok()
        );
        assert!(
            s.command(Command::Activate, &usable_with(2, 7, GameId::Ets2, 3.0))
                .result
                .is_ok()
        );
        assert!(s.permits_output());
    }

    #[test]
    fn a_fault_reset_works_even_without_telemetry() {
        let mut s = active();
        s.update(&Assessment::Unusable(Unusable::NoFrame));
        let r = s.command(
            Command::ResetFault,
            &Assessment::Unusable(Unusable::NoFrame),
        );
        assert_eq!(r.result, Ok(()));
        assert_eq!(s.state(), State::Disabled);
    }

    #[test]
    fn reset_outside_fault_is_refused_and_changes_nothing() {
        for mut s in [Supervisor::default(), armed(), active()] {
            let before = s.state();
            let r = s.command(Command::ResetFault, &ok());
            assert_eq!(r.result, Err(Rejection::NotInFault));
            assert_eq!(r.transition, None);
            assert_eq!(s.state(), before);
        }
    }

    #[test]
    fn arming_twice_is_refused() {
        for mut s in [armed(), active()] {
            let before = s.state();
            let r = s.command(Command::Arm, &ok());
            assert_eq!(r.result, Err(Rejection::AlreadyArmed));
            assert_eq!(s.state(), before);
        }
    }

    #[test]
    fn a_safety_event_while_arming_again_is_handled_first() {
        let mut s = active();
        let r = s.command(Command::Arm, &Assessment::Unusable(Unusable::Paused));
        assert_eq!(r.result, Err(Rejection::Safety(SafetyEvent::Paused)));
        assert_eq!(s.state(), State::Fault);
    }

    #[test]
    fn every_transition_has_a_reason_and_matches_the_reported_state() {
        let mut s = Supervisor::default();
        let steps: Vec<(Command, Assessment)> = vec![
            (Command::Arm, ok()),
            (Command::Activate, ok()),
            (Command::Disarm, ok()),
            (Command::Arm, ok()),
            (Command::Activate, usable_with(3, 7, GameId::Ets2, 3.0)),
            (Command::Arm, ok()),
            (Command::Activate, ok()),
            (Command::Activate, Assessment::Unusable(Unusable::Paused)),
            (Command::ResetFault, ok()),
        ];
        let mut count = 0;
        for (command, assessment) in steps {
            let before = s.state();
            let r = s.command(command, &assessment);
            if let Some(t) = r.transition {
                count += 1;
                assert_eq!(t.from, before);
                assert_eq!(t.to, s.state());
                assert_ne!(t.from, t.to);
                assert_eq!(s.last_transition(), Some(t));
            } else {
                assert_eq!(before, s.state(), "no transition means no state change");
            }
        }
        assert!(count >= 6);
    }

    #[test]
    fn only_the_active_state_permits_output() {
        let mut s = Supervisor::default();
        assert!(!s.permits_output());
        s.command(Command::Arm, &ok());
        assert!(!s.permits_output());
        s.command(Command::Activate, &ok());
        assert!(s.permits_output());
        s.update(&Assessment::Unusable(Unusable::Paused));
        assert!(!s.permits_output());
        s.command(Command::ResetFault, &ok());
        assert!(!s.permits_output());
    }
}
