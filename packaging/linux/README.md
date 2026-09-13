# Gryphon Linux release

This document specializes [Part 05 — CI, releases and local updates](../../../.docs/PART_05_CI_RELEASES_AND_LOCAL_UPDATES.md); that central contract remains authoritative.

The release archive contains the compiled `dist/` tree, `package.json`, and this
directory. Run `install.sh` as root after configuring Node.js 24+. The Updater
uses the same archive and performs subsequent directory swaps with health-check
rollback.
