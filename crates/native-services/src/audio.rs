//! Local audio playback owned by the native desktop runtime.

use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rodio::{Decoder, DeviceSinkBuilder, Player, Source};

use crate::{BlockingTask, ErrorCode, ServiceContext, ServiceError, ServiceResult};

const DEFAULT_VOLUME: f32 = 0.8;

/// Snapshot consumed by the GPUI controls. Durations are milliseconds so the
/// boundary remains serializable and independent of the playback library.
#[derive(Clone, Debug, PartialEq)]
pub struct AudioStatus {
    pub path: PathBuf,
    pub duration_ms: Option<u64>,
    pub position_ms: u64,
    pub playing: bool,
    pub finished: bool,
    pub volume: f32,
}

/// One decoded playback session. Implementations must remain safe to query
/// from the UI while the audio callback advances on its own thread.
pub trait AudioPlayback: Send + Sync {
    fn duration(&self) -> Option<Duration>;
    fn position(&self) -> Duration;
    fn is_paused(&self) -> bool;
    fn is_empty(&self) -> bool;
    fn play(&self);
    fn pause(&self);
    fn stop(&self);
    fn seek(&self, position: Duration) -> ServiceResult<()>;
    fn volume(&self) -> f32;
    fn set_volume(&self, volume: f32);
}

/// Decoder/output factory. Public so tests and alternate hosts can provide a
/// deterministic output device without changing production code paths.
pub trait AudioBackend: Send + Sync {
    fn open(&self, path: &Path) -> ServiceResult<Arc<dyn AudioPlayback>>;
}

struct RodioBackend;

struct RodioPlayback {
    _device: rodio::MixerDeviceSink,
    player: Player,
    duration: Option<Duration>,
}

impl AudioBackend for RodioBackend {
    fn open(&self, path: &Path) -> ServiceResult<Arc<dyn AudioPlayback>> {
        let file = File::open(path).map_err(|error| {
            ServiceError::from(error).operation(format!("open audio {}", path.display()))
        })?;
        let decoder = Decoder::try_from(file).map_err(|error| {
            ServiceError::new(
                ErrorCode::Unsupported,
                format!("Unable to decode audio: {error}"),
            )
            .operation(format!("decode audio {}", path.display()))
        })?;
        let duration = decoder.total_duration();
        let device = DeviceSinkBuilder::open_default_sink().map_err(|error| {
            ServiceError::new(
                ErrorCode::RemoteUnavailable,
                format!("No usable audio output device is available: {error}"),
            )
            .retryable(true)
            .operation("open default audio output")
        })?;
        let player = Player::connect_new(device.mixer());
        player.set_volume(DEFAULT_VOLUME);
        player.append(decoder);
        player.pause();
        Ok(Arc::new(RodioPlayback {
            _device: device,
            player,
            duration,
        }))
    }
}

impl AudioPlayback for RodioPlayback {
    fn duration(&self) -> Option<Duration> {
        self.duration
    }

    fn position(&self) -> Duration {
        self.player.get_pos()
    }

    fn is_paused(&self) -> bool {
        self.player.is_paused()
    }

    fn is_empty(&self) -> bool {
        self.player.empty()
    }

    fn play(&self) {
        self.player.play();
    }

    fn pause(&self) {
        self.player.pause();
    }

    fn stop(&self) {
        self.player.stop();
    }

    fn seek(&self, position: Duration) -> ServiceResult<()> {
        self.player.try_seek(position).map_err(|error| {
            ServiceError::new(
                ErrorCode::Unsupported,
                format!("Unable to seek audio: {error}"),
            )
            .operation("seek audio")
        })
    }

    fn volume(&self) -> f32 {
        self.player.volume()
    }

    fn set_volume(&self, volume: f32) {
        self.player.set_volume(volume);
    }
}

struct ActiveAudio {
    path: PathBuf,
    playback: Arc<dyn AudioPlayback>,
}

/// Single-session audio controller. Starting any new load invalidates and
/// stops the previous one, including a decoder still being prepared.
#[derive(Clone)]
pub struct AudioService {
    context: ServiceContext,
    backend: Arc<dyn AudioBackend>,
    active: Arc<Mutex<Option<ActiveAudio>>>,
    generation: Arc<AtomicU64>,
}

impl AudioService {
    pub fn new(context: ServiceContext) -> Self {
        Self::with_backend(context, Arc::new(RodioBackend))
    }

    pub fn with_backend(context: ServiceContext, backend: Arc<dyn AudioBackend>) -> Self {
        Self {
            context,
            backend,
            active: Arc::new(Mutex::new(None)),
            generation: Arc::new(AtomicU64::new(0)),
        }
    }

    pub fn load(&self, path: PathBuf) -> BlockingTask<AudioStatus> {
        let generation = self
            .generation
            .fetch_add(1, Ordering::AcqRel)
            .wrapping_add(1);
        self.stop_active();
        let backend = Arc::clone(&self.backend);
        let active = Arc::clone(&self.active);
        let current_generation = Arc::clone(&self.generation);
        self.context.spawn_blocking(move || {
            validate_audio_path(&path)?;
            let playback = backend.open(&path)?;
            if current_generation.load(Ordering::Acquire) != generation {
                playback.stop();
                return Err(ServiceError::new(
                    ErrorCode::Cancelled,
                    "Audio load was superseded",
                ));
            }
            let mut guard = active
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            *guard = Some(ActiveAudio {
                path: path.clone(),
                playback,
            });
            status_from_active(guard.as_ref().expect("audio session was just installed"))
        })
    }

    pub fn status(&self) -> ServiceResult<AudioStatus> {
        let guard = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let active = guard.as_ref().ok_or_else(no_active_audio)?;
        status_from_active(active)
    }

    pub fn play(&self) -> ServiceResult<AudioStatus> {
        self.with_active(|active| {
            if active.playback.is_empty() {
                active.playback.seek(Duration::ZERO)?;
            }
            active.playback.play();
            status_from_active(active)
        })
    }

    pub fn pause(&self) -> ServiceResult<AudioStatus> {
        self.with_active(|active| {
            active.playback.pause();
            status_from_active(active)
        })
    }

    pub fn seek(&self, position_ms: u64) -> ServiceResult<AudioStatus> {
        self.with_active(|active| {
            let requested = Duration::from_millis(position_ms);
            let position = active
                .playback
                .duration()
                .map_or(requested, |duration| requested.min(duration));
            active.playback.seek(position)?;
            status_from_active(active)
        })
    }

    pub fn set_volume(&self, volume: f32) -> ServiceResult<AudioStatus> {
        self.with_active(|active| {
            active.playback.set_volume(volume.clamp(0.0, 1.0));
            status_from_active(active)
        })
    }

    pub fn stop(&self) {
        self.generation.fetch_add(1, Ordering::AcqRel);
        self.stop_active();
    }

    fn with_active<T>(
        &self,
        operation: impl FnOnce(&ActiveAudio) -> ServiceResult<T>,
    ) -> ServiceResult<T> {
        let guard = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        operation(guard.as_ref().ok_or_else(no_active_audio)?)
    }

    fn stop_active(&self) {
        if let Some(active) = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            active.playback.stop();
        }
    }
}

fn validate_audio_path(path: &Path) -> ServiceResult<()> {
    if !path.is_file() {
        return Err(ServiceError::new(
            ErrorCode::NotFound,
            format!("Audio file does not exist: {}", path.display()),
        ));
    }
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !matches!(extension.as_str(), "mp3" | "wav" | "flac" | "ogg" | "m4a") {
        return Err(ServiceError::new(
            ErrorCode::Unsupported,
            format!("Native audio playback does not support .{extension}"),
        ));
    }
    Ok(())
}

fn no_active_audio() -> ServiceError {
    ServiceError::new(ErrorCode::InvalidInput, "No audio preview is active")
}

fn status_from_active(active: &ActiveAudio) -> ServiceResult<AudioStatus> {
    let duration = active.playback.duration();
    let position = active.playback.position();
    let finished = active.playback.is_empty();
    Ok(AudioStatus {
        path: active.path.clone(),
        duration_ms: duration.map(duration_ms),
        position_ms: duration_ms(position),
        playing: !active.playback.is_paused() && !finished,
        finished,
        volume: active.playback.volume(),
    })
}

fn duration_ms(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::sync::mpsc;

    use super::*;

    #[derive(Debug)]
    struct FakeState {
        position: Duration,
        paused: bool,
        stopped: bool,
        volume: f32,
    }

    impl Default for FakeState {
        fn default() -> Self {
            Self {
                position: Duration::ZERO,
                paused: true,
                stopped: false,
                volume: DEFAULT_VOLUME,
            }
        }
    }

    #[derive(Default)]
    struct FakePlayback {
        state: Mutex<FakeState>,
    }

    impl AudioPlayback for FakePlayback {
        fn duration(&self) -> Option<Duration> {
            Some(Duration::from_secs(120))
        }

        fn position(&self) -> Duration {
            self.state.lock().unwrap().position
        }

        fn is_paused(&self) -> bool {
            self.state.lock().unwrap().paused
        }

        fn is_empty(&self) -> bool {
            self.state.lock().unwrap().stopped
        }

        fn play(&self) {
            let mut state = self.state.lock().unwrap();
            state.paused = false;
            state.stopped = false;
        }

        fn pause(&self) {
            self.state.lock().unwrap().paused = true;
        }

        fn stop(&self) {
            let mut state = self.state.lock().unwrap();
            state.stopped = true;
            state.paused = true;
        }

        fn seek(&self, position: Duration) -> ServiceResult<()> {
            let mut state = self.state.lock().unwrap();
            state.position = position;
            state.stopped = false;
            Ok(())
        }

        fn volume(&self) -> f32 {
            self.state.lock().unwrap().volume
        }

        fn set_volume(&self, volume: f32) {
            self.state.lock().unwrap().volume = volume;
        }
    }

    struct FixedBackend {
        playback: Arc<FakePlayback>,
    }

    impl AudioBackend for FixedBackend {
        fn open(&self, _path: &Path) -> ServiceResult<Arc<dyn AudioPlayback>> {
            Ok(self.playback.clone())
        }
    }

    fn fixture_service(root: &Path, playback: Arc<FakePlayback>) -> AudioService {
        AudioService::with_backend(
            ServiceContext::new(crate::ResourcePaths::test(root)),
            Arc::new(FixedBackend { playback }),
        )
    }

    #[test]
    fn loads_paused_and_controls_one_native_session() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("song.wav");
        std::fs::write(&path, b"fixture").unwrap();
        let playback = Arc::new(FakePlayback::default());
        let service = fixture_service(directory.path(), Arc::clone(&playback));

        let loaded = service.load(path.clone()).wait().unwrap();
        assert_eq!(loaded.path, path);
        assert_eq!(loaded.duration_ms, Some(120_000));
        assert!(!loaded.playing);

        assert!(service.play().unwrap().playing);
        assert_eq!(service.seek(130_000).unwrap().position_ms, 120_000);
        assert_eq!(service.set_volume(2.0).unwrap().volume, 1.0);
        assert!(!service.pause().unwrap().playing);

        service.stop();
        assert_eq!(service.status().unwrap_err().code, ErrorCode::InvalidInput);
        assert!(playback.state.lock().unwrap().stopped);
    }

    #[test]
    fn rejects_missing_and_unsupported_files_before_opening_output() {
        let directory = tempfile::tempdir().unwrap();
        let service = fixture_service(directory.path(), Arc::new(FakePlayback::default()));
        let missing = service
            .load(directory.path().join("missing.wav"))
            .wait()
            .unwrap_err();
        assert_eq!(missing.code, ErrorCode::NotFound);

        let unsupported = directory.path().join("song.wma");
        std::fs::write(&unsupported, b"fixture").unwrap();
        let error = service.load(unsupported).wait().unwrap_err();
        assert_eq!(error.code, ErrorCode::Unsupported);
    }

    struct StaleBackend {
        entered: mpsc::Sender<()>,
        release: Mutex<mpsc::Receiver<()>>,
    }

    impl AudioBackend for StaleBackend {
        fn open(&self, path: &Path) -> ServiceResult<Arc<dyn AudioPlayback>> {
            if path.file_stem().is_some_and(|name| name == "first") {
                let _ = self.entered.send(());
                let _ = self.release.lock().unwrap().recv();
            }
            Ok(Arc::new(FakePlayback::default()))
        }
    }

    #[test]
    fn superseded_decoder_cannot_replace_the_newer_audio_session() {
        let directory = tempfile::tempdir().unwrap();
        let first = directory.path().join("first.wav");
        let second = directory.path().join("second.wav");
        std::fs::write(&first, b"fixture").unwrap();
        std::fs::write(&second, b"fixture").unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let service = AudioService::with_backend(
            ServiceContext::new(crate::ResourcePaths::test(directory.path())),
            Arc::new(StaleBackend {
                entered: entered_tx,
                release: Mutex::new(release_rx),
            }),
        );

        let first_task = service.load(first);
        entered_rx.recv().unwrap();
        let second_status = service.load(second.clone()).wait().unwrap();
        assert_eq!(second_status.path, second);
        release_tx.send(()).unwrap();
        assert_eq!(first_task.wait().unwrap_err().code, ErrorCode::Cancelled);
        assert_eq!(service.status().unwrap().path, second);
    }
}
