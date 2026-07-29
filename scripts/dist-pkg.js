const fs = require("fs");
const path = require("path");

const pkg = require("../package.json");
const out = path.resolve(__dirname, "..", "dist", "pkg");

// Clean and create output directory
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

// The FROZEN legacy client (public/app, and the copy publicDir leaves in the
// build output) must never ride along into a package — mirrors the "!app/**"
// filters in package.json's build.files / build.extraResources.
const skipLegacyApp = (src, root) => {
  const rel = path.relative(root, src);
  return rel !== "app" && !rel.startsWith(`app${path.sep}`);
};

// Copy compiled electron + webapp
for (const dir of ["dist/electron", "dist/webapp"]) {
  fs.cpSync(dir, path.join(out, dir), {
    recursive: true,
    filter: (src) => skipLegacyApp(src, path.resolve(dir)),
  });
}

// Copy public (extraResources equivalent)
fs.cpSync("public", path.join(out, "public"), {
  recursive: true,
  filter: (src) => skipLegacyApp(src, path.resolve("public")),
});

// Copy assets if present
if (fs.existsSync("assets")) {
  fs.cpSync("assets", path.join(out, "assets"), { recursive: true });
}

const dependencies = {
  ...(pkg.dependencies || {}),
};

if (!dependencies.electron && pkg.devDependencies?.electron) {
  dependencies.electron = pkg.devDependencies.electron;
}

if (!dependencies["electron-builder"] && pkg.devDependencies?.["electron-builder"]) {
  dependencies["electron-builder"] = pkg.devDependencies["electron-builder"];
}

// Write a minimal package.json with only production dependencies
fs.writeFileSync(
  path.join(out, "package.json"),
  JSON.stringify(
    {
      name: pkg.name,
      version: pkg.version,
      main: "dist/electron/main.js",
      dependencies,
    },
    null,
    2
  )
);

fs.writeFileSync(
  path.join(out, "start.sh"),
  `#!/bin/sh
set -e

cd "$(dirname "$0")"

print_info() {
  echo "[INFO] $1"
}

print_warn() {
  echo "[WARN] $1"
}

print_error() {
  echo "[ERROR] $1"
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

platform="unknown"
uname_out="$(uname -s 2>/dev/null || echo unknown)"
case "$uname_out" in
  Linux*) platform="linux" ;;
  Darwin*) platform="macos" ;;
  CYGWIN*|MINGW*|MSYS*) platform="windows" ;;
esac

print_info "Detected platform: $platform ($uname_out)"

has_admin_privileges() {
  if [ "\${platform}" = "windows" ]; then
    return 1
  fi

  if command_exists id && [ "$(id -u)" -eq 0 ]; then
    return 0
  fi

  if command_exists sudo && sudo -n true >/dev/null 2>&1; then
    return 0
  fi

  return 1
}

run_install_command() {
  install_command="$1"

  if [ "\${platform}" = "windows" ]; then
    sh -c "$install_command"
    return $?
  fi

  if command_exists id && [ "$(id -u)" -eq 0 ]; then
    sh -c "$install_command"
    return $?
  fi

  if command_exists sudo; then
    sudo sh -c "$install_command"
    return $?
  fi

  return 1
}

install_node_and_npm() {
  print_warn "Node.js and/or npm were not found. Trying automatic installation..."

  if [ "$platform" = "windows" ]; then
    if command_exists winget; then
      print_info "Using winget to install Node.js LTS..."
      if winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements; then
        return 0
      fi
      print_warn "winget installation failed."
    fi

    if command_exists choco; then
      print_info "Using Chocolatey to install Node.js LTS..."
      if choco install nodejs-lts -y; then
        return 0
      fi
      print_warn "Chocolatey installation failed."
    fi

    if command_exists scoop; then
      print_info "Using Scoop to install Node.js LTS..."
      if scoop install nodejs-lts; then
        return 0
      fi
      print_warn "Scoop installation failed."
    fi

    print_error "Could not install Node.js automatically on Windows."
    echo "Please install Node.js LTS manually from: https://nodejs.org/"
    echo "Then reopen your terminal and run ./start.sh again."
    return 1
  fi

  if [ "$platform" = "macos" ]; then
    if command_exists brew; then
      print_info "Using Homebrew to install Node.js..."
      if brew install node; then
        return 0
      fi
      print_warn "Homebrew installation failed."
      return 1
    fi

    print_error "Homebrew was not found."
    echo "Install Homebrew first: https://brew.sh"
    echo "Then run: brew install node"
    return 1
  fi

  if [ "$platform" = "linux" ]; then
    if ! has_admin_privileges; then
      print_error "Administrator privileges are required to install Node.js automatically."
      echo "Please run one of the following commands manually:"
      echo "  Debian/Ubuntu: sudo apt-get update && sudo apt-get install -y nodejs npm"
      echo "  Fedora:        sudo dnf install -y nodejs npm"
      echo "  Arch:          sudo pacman -Sy --noconfirm nodejs npm"
      echo "  Alpine:        sudo apk add --no-cache nodejs npm"
      return 1
    fi

    if command_exists apt-get; then
      print_info "Using apt-get to install Node.js + npm..."
      run_install_command "apt-get update && apt-get install -y nodejs npm" && return 0
    elif command_exists dnf; then
      print_info "Using dnf to install Node.js + npm..."
      run_install_command "dnf install -y nodejs npm" && return 0
    elif command_exists yum; then
      print_info "Using yum to install Node.js + npm..."
      run_install_command "yum install -y nodejs npm" && return 0
    elif command_exists pacman; then
      print_info "Using pacman to install Node.js + npm..."
      run_install_command "pacman -Sy --noconfirm nodejs npm" && return 0
    elif command_exists zypper; then
      print_info "Using zypper to install Node.js + npm..."
      run_install_command "zypper --non-interactive install nodejs npm" && return 0
    elif command_exists apk; then
      print_info "Using apk to install Node.js + npm..."
      run_install_command "apk add --no-cache nodejs npm" && return 0
    fi

    print_error "No supported package manager found for automatic install."
    echo "Please install Node.js LTS manually from your distribution repositories or https://nodejs.org/"
    return 1
  fi

  print_error "Unsupported platform for automatic setup."
  echo "Please install Node.js LTS manually from https://nodejs.org/ and re-run this script."
  return 1
}

ensure_node_and_npm() {
  if command_exists node && command_exists npm; then
    return 0
  fi

  install_node_and_npm || return 1

  if ! command_exists node || ! command_exists npm; then
    print_error "Node.js or npm is still unavailable after installation attempt."
    echo "Please restart your terminal session and run ./start.sh again."
    return 1
  fi

  return 0
}

needs_npm_install=0

if [ ! -d "node_modules" ]; then
  needs_npm_install=1
elif [ ! -f "node_modules/electron/package.json" ] && [ ! -x "node_modules/.bin/electron" ]; then
  needs_npm_install=1
elif [ -f "package-lock.json" ] && [ "package-lock.json" -nt "node_modules" ]; then
  needs_npm_install=1
fi

ensure_node_and_npm || exit 1

if [ "$needs_npm_install" -eq 1 ]; then
  print_info "Installing npm dependencies..."
  npm install --no-audit --no-fund
else
  print_info "Dependencies already installed."
fi

print_info "Starting PraiseProjector with Electron..."
if [ -x "./node_modules/.bin/electron" ]; then
  ./node_modules/.bin/electron .
else
  npx electron .
fi
`
);
fs.chmodSync(path.join(out, "start.sh"), 0o755);

console.log(`\nCreated dist/pkg (v${pkg.version})`);
console.log("To run:\n  cd dist/pkg && npm install && ./start.sh");
