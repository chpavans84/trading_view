#!/usr/bin/env bash
# setup_new_mac.sh — one-shot setup for the trading dashboard on a fresh Mac.
# Run from the project root: bash scripts/setup_new_mac.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
die()  { echo -e "${RED}✗${NC} $*"; exit 1; }
step() { echo -e "\n${YELLOW}▶ $*${NC}"; }

cd "$PROJECT_DIR"

# ── 1. Xcode CLI tools ────────────────────────────────────────────────────────
step "Checking Xcode Command Line Tools"
if xcode-select -p &>/dev/null; then
  ok "Xcode CLI tools already installed"
else
  warn "Installing Xcode CLI tools (this may take a few minutes)..."
  xcode-select --install
  echo "  After the installer finishes, re-run this script."
  exit 0
fi

# ── 2. Homebrew ───────────────────────────────────────────────────────────────
step "Checking Homebrew"
if command -v brew &>/dev/null; then
  ok "Homebrew already installed"
else
  warn "Installing Homebrew..."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  # Add brew to PATH for Apple Silicon
  if [[ -f /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi
fi

# ── 3. Node.js ────────────────────────────────────────────────────────────────
step "Checking Node.js"
NODE_REQUIRED=25
if command -v node &>/dev/null; then
  NODE_MAJOR=$(node --version | cut -d. -f1 | tr -d v)
  if [[ "$NODE_MAJOR" -ge "$NODE_REQUIRED" ]]; then
    ok "Node.js $(node --version) — OK"
  else
    warn "Node.js $(node --version) is too old. Need v${NODE_REQUIRED}+."
    warn "Install via nvm:"
    echo "  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash"
    echo "  source ~/.zshrc && nvm install ${NODE_REQUIRED} && nvm alias default ${NODE_REQUIRED}"
    exit 1
  fi
else
  die "Node.js not found. Install via nvm: https://github.com/nvm-sh/nvm"
fi

# ── 4. PostgreSQL ─────────────────────────────────────────────────────────────
step "Checking PostgreSQL"
if command -v psql &>/dev/null; then
  ok "PostgreSQL already available"
else
  warn "Installing PostgreSQL 16..."
  brew install postgresql@16
  brew services start postgresql@16
  echo 'export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"' >> ~/.zshrc
  export PATH="/opt/homebrew/opt/postgresql@16/bin:$PATH"
  sleep 2
fi

# ── 5. .env file ─────────────────────────────────────────────────────────────
step "Checking .env"
if [[ -f "$PROJECT_DIR/.env" ]]; then
  ok ".env already exists"
else
  if [[ -f "$PROJECT_DIR/.env.example" ]]; then
    cp "$PROJECT_DIR/.env.example" "$PROJECT_DIR/.env"
    warn ".env created from .env.example — fill in your values before starting."
  else
    die ".env.example not found. Cannot create .env."
  fi
fi

# ── 6. npm install ────────────────────────────────────────────────────────────
step "Installing npm dependencies (compiles node-pty from source)"
npm install
ok "npm install complete"

# Rebuild node-pty explicitly to be sure
step "Rebuilding node-pty"
npm rebuild node-pty && ok "node-pty compiled successfully" || warn "node-pty rebuild failed — browser terminal (admin panel) won't work, rest of app is unaffected"

# ── 7. Database setup ─────────────────────────────────────────────────────────
step "Checking database"
# Source .env to read DATABASE_URL
set -a; source "$PROJECT_DIR/.env" 2>/dev/null || true; set +a

if [[ -n "${DATABASE_URL:-}" ]]; then
  if psql "$DATABASE_URL" -c "SELECT 1" &>/dev/null; then
    ok "Database connection works"
  else
    warn "Cannot connect to database. Make sure PostgreSQL is running and DATABASE_URL is correct."
    warn "Create DB manually:"
    echo "  psql postgres -c \"CREATE USER postgres WITH SUPERUSER PASSWORD 'yourpassword';\""
    echo "  psql postgres -c \"CREATE DATABASE tradingbot OWNER postgres;\""
    echo "  psql \"\$DATABASE_URL\" < tradingbot_backup.sql   # if you have a backup"
  fi
else
  warn "DATABASE_URL not set in .env — skipping DB check"
fi

# ── 8. Summary ────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo -e "${GREEN}  Setup complete${NC}"
echo -e "${GREEN}═══════════════════════════════════════════${NC}"
echo ""
echo "Next steps:"
echo "  1. Edit .env with your real credentials (ANTHROPIC_API_KEY, TELEGRAM_*, etc.)"
echo "  2. Start Moomoo OpenD and log in"
echo "  3. npm run dashboard"
echo "  4. Open http://localhost:3000"
echo ""
echo "For TradingView chart tools:"
echo "  bash scripts/launch_tv_debug_mac.sh"
echo ""
echo "Full migration guide: MIGRATION.md"
