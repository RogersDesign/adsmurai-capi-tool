# Adsmurai – Solutions Engineering / Data & Measurement  
## Meta Conversions API – Offline Events Uploader

This project is a Node.js CLI tool developed as part of the Adsmurai technical assessment.  
It downloads a CSV file containing offline POS purchases, normalizes and hashes user data according to Meta Conversions API requirements, and sends `Purchase` events to Meta using the Conversions API.

---

## Features

- Downloads a CSV file from a Google Drive `/view` URL (automatically converted to direct download)
- Supports `Windows-1252 (cp1252)` encoding
- Automatically detects CSV delimiter (`;` or `,`)
- Handles duplicated column names (e.g. `email`, `email`, `email`) by renaming them to:
  - `email`
  - `email.1`
  - `email.2`
- Processes one offline conversion per row
- Sends `Purchase` events with `action_source: physical_store`
- Normalizes and hashes user data using SHA-256
- Supports multiple emails per user (sent as an array in `user_data.em`, deduplicated)
- Deterministic `event_id` generation for deduplication
- Batch sending support
- `DRY_RUN` mode for safe testing
- Structured logging for validation and debugging

---

## Requirements

- Node.js **>= 18** (recommended: Node.js 20 LTS)
- npm

---

## Installation

```bash
npm install