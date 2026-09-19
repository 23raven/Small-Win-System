"use strict";

let activeTimerId = null;
let timerHandle = null;

function clearTimer() {
  if (timerHandle) clearTimeout(timerHandle);
  timerHandle = null;
  activeTimerId = null;
}

function schedule(data) {
  clearTimer();

  activeTimerId = data.timerId;
  const target = Number(data.deadline);

  const check = () => {
    if (activeTimerId !== data.timerId) return;

    const remaining = target - Date.now();

    if (remaining <= 0) {
      self.postMessage({
        type: "complete",
        timerId: data.timerId,
        completedAt: Date.now()
      });
      clearTimer();
      return;
    }

    // Absolute deadline is authoritative; the repeated timer only wakes the worker.
    timerHandle = setTimeout(check, Math.min(1000, Math.max(100, remaining)));
  };

  timerHandle = setTimeout(check, Math.min(1000, Math.max(100, target - Date.now())));
}

self.onmessage = event => {
  const data = event.data || {};

  if (data.type === "start") {
    schedule(data);
  }

  if (data.type === "cancel") {
    if (data.timerId === activeTimerId) clearTimer();
  }
};
