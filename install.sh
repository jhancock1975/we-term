#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "Installing we-term service..."

sudo cp "$SCRIPT_DIR/we-term.service" /etc/systemd/system/we-term.service
sudo systemctl daemon-reload
sudo systemctl enable we-term
sudo systemctl start we-term

echo "we-term service installed and started."
echo "Access at http://10.0.0.196:9090"
echo ""
echo "Commands:"
echo "  sudo systemctl status we-term    # check status"
echo "  sudo systemctl restart we-term   # restart"
echo "  sudo systemctl stop we-term      # stop"
echo "  sudo journalctl -u we-term -f    # view logs"
