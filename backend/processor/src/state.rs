use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};

#[derive(Clone)]
pub(crate) struct RuntimeState {
    stop: Arc<AtomicBool>,
    pause: Arc<(Mutex<bool>, Condvar)>,
}

impl RuntimeState {
    pub(crate) fn new() -> Self {
        Self {
            stop: Arc::new(AtomicBool::new(false)),
            pause: Arc::new((Mutex::new(false), Condvar::new())),
        }
    }

    pub(crate) fn reset(&self) {
        self.stop.store(false, Ordering::SeqCst);
        self.set_paused(false);
    }

    pub(crate) fn set_paused(&self, paused: bool) {
        let (lock, cvar) = &*self.pause;
        let mut guard = lock.lock().expect("pause lock poisoned");
        *guard = paused;
        if !paused {
            cvar.notify_all();
        }
    }

    pub(crate) fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
        self.set_paused(false);
    }

    pub(crate) fn should_stop(&self) -> bool {
        self.stop.load(Ordering::SeqCst)
    }

    pub(crate) fn wait_if_paused(&self) {
        let (lock, cvar) = &*self.pause;
        let mut paused = lock.lock().expect("pause lock poisoned");
        while *paused && !self.should_stop() {
            paused = cvar.wait(paused).expect("pause wait poisoned");
        }
    }
}
