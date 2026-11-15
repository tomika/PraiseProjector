const fs = require("node:fs/promises");
const path = require("node:path");

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

exports.default = async function afterPackLinuxNoSandbox(context) {
  if (context.electronPlatformName !== "linux") {
    return;
  }

  const executableName = context.packager.executableName;
  const appOutDir = context.appOutDir;
  const executablePath = path.join(appOutDir, executableName);
  const realBinaryPath = path.join(appOutDir, `${executableName}.bin`);

  if (!(await fileExists(executablePath))) {
    throw new Error(`Linux executable not found: ${executablePath}`);
  }

  if (!(await fileExists(realBinaryPath))) {
    await fs.rename(executablePath, realBinaryPath);
  } else {
    await fs.unlink(executablePath);
  }

  // Native Wayland (Electron's default in a Wayland session since v38, and the only
  // GNOME session since Ubuntu 26.04) neither reports a window's global position nor
  // honours a requested one. The projector would then exclude the wrong monitor and
  // open on the main window's monitor. XWayland keeps X11 placement semantics, so it
  // is used whenever an X display is available. An --ozone-platform=... argument
  // passed by the user comes later on the command line and therefore still wins.
  const wrapper = `#!/bin/sh
HERE="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
export ELECTRON_DISABLE_SANDBOX=1
PP_OZONE_ARG=""
if [ -n "$DISPLAY" ]; then
  PP_OZONE_ARG="--ozone-platform=x11"
fi
exec "$HERE/${executableName}.bin" --no-sandbox --disable-gpu-sandbox $PP_OZONE_ARG "$@"
`;

  await fs.writeFile(executablePath, wrapper, "utf8");
  await fs.chmod(executablePath, 0o755);
  await fs.chmod(realBinaryPath, 0o755);
};