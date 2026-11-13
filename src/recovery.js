export function assertWorkerPidAbsent(pid, signalProcess = process.kill) {
  // A crash can occur before the worker PID is journaled. In that case the
  // operator's process-tree confirmation is the only evidence available.
  if (pid === null) return;
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Recorded worker PID is invalid');
  try {
    signalProcess(pid, 0);
  } catch (error) {
    if (error.code === 'ESRCH') return;
    throw new Error('Cannot confirm absence of recorded worker PID ' + pid);
  }
  throw new Error('Recorded worker PID ' + pid + ' is still present');
}
