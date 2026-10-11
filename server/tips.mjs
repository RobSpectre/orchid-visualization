// Diagnostic tips for every alert and failing check: ordered steps an operator
// can follow at the booth, with copyable commands. Paths and ports come from the
// server's options so the commands match this machine.
//
// A tip is { text, cmd? }: text explains, cmd (optional) is a shell command or URL.

export function createTips({ studioDir, studioPort, robotDir, robotPython, robotPort, vizDir, vizPort }) {
  const studioStart = `cd ${studioDir} && scripts/start-macos.sh --sound-input Orchid --chord-channel 3`;
  const robotStart = `cd ${robotDir} && ${robotPython} app.py --enable-hardware --port ${robotPort}`;
  const robotUrl = `http://127.0.0.1:${robotPort}`;

  return {
    // ---------------------------------------------------------------- Studio
    studioOffline: () => [
      { text: 'Is Studio running? This lists the process listening on its port (no output = not running).', cmd: `lsof -nP -iTCP:${studioPort} -sTCP:LISTEN` },
      { text: 'Start Studio:', cmd: studioStart },
      { text: 'If it is running but not answering, it may be loading samples or the Pistil host. Wait 10–20 s, then open its control page. If the page loads, the problem is the visualizer server, not Studio.', cmd: `http://127.0.0.1:${studioPort}/` },
      { text: 'Still stuck? Stop Studio cleanly, then start it again with the command above.', cmd: `cd ${studioDir} && .venv/bin/orchid-studio request '{"command":"quit"}'` },
    ],
    studioSlow: () => [
      { text: 'Studio answered, but slowly or not recently. It is usually busy (loading a beat or samples). Give it a few seconds.' },
      { text: 'If it stays stale, check Studio is responsive:', cmd: `cd ${studioDir} && .venv/bin/orchid-studio request '{"command":"status"}'` },
    ],
    orchid: (detail = '') => [
      { text: 'Check the Orchid is powered on and its USB cable is firmly connected to this Mac. Try another port or cable if unsure.' },
      { text: "On the Orchid, confirm USB MIDI is on and the raw Chord channel is 3 (Studio is listening on channel 3)." },
      { text: 'Check macOS sees it: the Orchid should be listed as a MIDI input named "Orchid".', cmd: `cd ${studioDir} && .venv/bin/orchid-studio doctor --midi` },
      { text: 'Quit anything else that may hold the Orchid MIDI port (Pistil standalone, GarageBand, Logic).' },
      { text: /stale/i.test(detail)
        ? 'Studio sees the Orchid but has had no MIDI from it recently. Press a key; if nothing registers, replug the USB cable.'
        : 'Studio reconnects on its own within a few seconds of replugging. If it does not, restart Studio.', cmd: /stale/i.test(detail) ? undefined : studioStart },
    ],
    keyMonitor: () => [
      { text: 'The key monitor reads the Orchid’s keys for the robot’s key checks. It needs the Orchid connected (see above).' },
      { text: 'Restart Studio with the Orchid as its sound input so the monitor opens:', cmd: studioStart },
    ],
    pistil: () => [
      { text: 'Pistil is the sound engine. Check the Pistil Audio Unit is installed and activated on this Mac.' },
      { text: 'Run Studio’s checks:', cmd: `cd ${studioDir} && .venv/bin/orchid-studio doctor` },
      { text: 'Rebuild the native host if it was updated, then restart Studio:', cmd: `cd ${studioDir} && .venv/bin/orchid-studio build-host` },
    ],
    studioComponent: (name) => [
      { text: `${name} is not ready. It usually follows the Orchid connection; fix that first.` },
      { text: 'If the Orchid is fine, restart Studio:', cmd: studioStart },
    ],

    // ---------------------------------------------------------------- robot
    robotOffline: () => [
      { text: 'Is the robot console running? (no output = not running)', cmd: `lsof -nP -iTCP:${robotPort} -sTCP:LISTEN` },
      { text: 'Start it (hardware mode):', cmd: robotStart },
      { text: 'Then open the console, connect both arms, and take control. Keep that browser tab open: closing it stops the arms.', cmd: robotUrl },
      { text: 'If it refuses to start with a lock error, another copy is already running on the same data folder. Close the other one first.' },
    ],
    armStopped: (name, error = '') => {
      const tips = [
        { text: `Open the robot console and switch to the ${name}.`, cmd: robotUrl },
        { text: 'Support the arm by hand, then press “Hold & keep playing”. The arm cannot be restarted remotely; this is a safety latch.' },
      ];
      if (/operator connection lost/i.test(error)) {
        tips.push({ text: 'Cause: the console tab that was controlling the arms closed, reloaded, or the Mac slept. Keep exactly one console tab open and in control, and keep the Mac awake.' });
      } else if (/status packet|sync read|TxRxResult|Present_Position|no response/i.test(error)) {
        tips.push({ text: 'Cause: the arm’s motors stopped answering on the serial bus. If all of them failed at once, it is power or the main cable, not one motor.' });
        tips.push({ text: 'Check the arm’s motor power supply is on (motor LEDs lit) and its USB cable to this Mac is seated. Then check the short cables chaining motor to motor, especially at the base.' });
        tips.push({ text: 'Reconnect the arm in the robot console, then press Hold & keep playing.', cmd: robotUrl });
      } else if (/motor worker stopped|serial|port|timeout|timed out/i.test(error)) {
        tips.push({ text: 'Cause: the control loop lost the motors. Check the arm’s power supply and USB cable, then reconnect the arm in the console.' });
        tips.push({ text: 'If it keeps happening, restart the robot app:', cmd: robotStart });
      } else {
        tips.push({ text: 'Read the reason in the console’s event log, and check motor temperatures and joint limits on the status page.' });
      }
      tips.push({ text: 'If it stops again right away, power-cycle that arm (motor power off, wait 5 s, on), reconnect it in the console, and re-check calibration.' });
      return tips;
    },
    armDisconnected: (name) => [
      { text: `Check the ${name}’s motor power supply is on and its USB cable is connected to this Mac.` },
      { text: `Open the robot console, switch to the ${name}, and press Connect. If the serial port changed after replugging, pick it again.`, cmd: robotUrl },
      { text: 'After reconnecting, confirm calibration in the console before playing.' },
    ],
    armHot: () => [
      { text: 'A motor is running hot. Let the arm rest at home for a few minutes, and reduce arm speed in the console.' },
    ],
    armLimits: () => [
      { text: 'A joint is outside its calibrated range. Move the arm back by hand with torque off, then re-check calibration in the console.' },
    ],

    // ---------------------------------------------------------------- Hermes
    hermesOffline: () => [
      { text: 'The visualizer cannot read Hermes’ state database. Check it exists:', cmd: 'ls -la ~/.hermes/state.db' },
      { text: 'Check Hermes is healthy:', cmd: 'hermes gateway status' },
    ],
    gatewayDown: () => [
      { text: 'Check the gateway:', cmd: 'hermes gateway status' },
      { text: 'Restart it:', cmd: 'hermes gateway restart' },
      { text: 'If it will not stay up, run it in the foreground to see the error:', cmd: 'hermes gateway run' },
      { text: 'Recent gateway errors:', cmd: 'tail -n 40 ~/.hermes/logs/gateway.error.log' },
    ],
    platform: (label) => [
      { text: `Check the phone running ${label} has internet and ${label} is open. Linked devices drop if the phone is offline for a long time.` },
      { text: 'See what the gateway reports:', cmd: 'hermes gateway status' },
      { text: 'Restart the gateway (it reconnects the WhatsApp bridge):', cmd: 'hermes gateway restart' },
      { text: `If it says logged out or needs pairing, re-link: run this, then scan the QR code from the phone (${label} → Linked devices).`, cmd: 'hermes whatsapp' },
      { text: 'Bridge and gateway logs:', cmd: 'tail -n 40 ~/.hermes/logs/gateway.log' },
    ],
    hermesErrors: () => [
      { text: 'Read the recent errors:', cmd: 'tail -n 50 ~/.hermes/logs/errors.log' },
      { text: '401/403 from Token Factory means the API key is wrong or expired; 429 means rate limited; timeouts usually mean the network is down.' },
      { text: 'Check the configured model and provider:', cmd: 'hermes model' },
    ],
    sessionNotSaved: () => [
      { text: 'Hermes is running a session it could not write to its database. This usually means it was started by another macOS user who can’t write ~/.hermes/state.db.' },
      { text: 'Confirm in Hermes’ log: look for “session will NOT be indexed”.', cmd: 'grep -n "NOT be indexed" ~/.hermes/logs/agent.log | tail -3' },
      { text: 'The display still works: model, tokens/s, latency, tokens and context come from agent.log and the stream hook. The reasoning trace needs the stream hook (the orchid_viz plugin) loaded in that Hermes.' },
      { text: 'To have the session saved, run Hermes as the user who owns ~/.hermes, or give the other user its own Hermes home (with the orchid_viz plugin enabled).' },
    ],
    streamHook: () => [
      { text: 'Install (or update) the orchid_viz plugin for the user who runs Hermes. Run this as that user; it is safe to re-run:', cmd: `cd ${vizDir} && scripts/install-hermes-plugin.sh` },
      { text: 'Then restart that user’s Hermes CLI (and the gateway, for WhatsApp) so the plugin loads:', cmd: 'hermes gateway restart' },
    ],

    // ---------------------------------------------------------------- visualizer
    vizServer: () => [
      { text: 'Start the visualizer server:', cmd: `cd ${vizDir} && npm start` },
      { text: 'Then reload this page.', cmd: `http://127.0.0.1:${vizPort}/` },
    ],
  };
}
