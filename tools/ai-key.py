#!/usr/bin/env python3
# Puts the Gemini key for AI name suggestions into users.json, encrypted so that only a logged-in player
# (who has unlocked the players' GitHub token) can use it:
#   python3 tools/ai-key.py TOKEN_FILE GEMINI_KEY_FILE      (run in the repo folder; needs "cryptography")
# AES-256-GCM, key = SHA-256 of the players' token, associated data "celebs-ai". Re-run it whenever the
# players' token or the Gemini key changes. Neither key is printed.
import base64
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM


def main():
    if len(sys.argv) != 3:
        sys.exit("usage: ai-key.py TOKEN_FILE GEMINI_KEY_FILE")
    token = open(sys.argv[1]).read().strip()
    ai_key = open(sys.argv[2]).read().strip()
    iv = os.urandom(12)
    sealed = AESGCM(hashlib.sha256(token.encode()).digest()).encrypt(iv, ai_key.encode(), b"celebs-ai")
    users = json.load(open("users.json"))
    users["ai"] = {"iv": base64.b64encode(iv).decode(), "key": base64.b64encode(sealed).decode()}
    with open("users.json", "w") as f:
        f.write(json.dumps(users, ensure_ascii=False, indent=1) + "\n")
    print("users.json: AI key saved (encrypted)")


if __name__ == "__main__":
    main()
