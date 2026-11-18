#!/usr/bin/env python3
# Adds a player to users.json, or resets their password: python3 tools/users.py TOKEN_FILE NAME PASSWORD
# (admins can also do both on the page, in the admin console)
# (run in the repo folder; needs the Python "cryptography" package).
#
# Each player's entry holds the shared GitHub token (fine-grained, only this repo, Contents: read and
# write) encrypted with their password: PBKDF2-SHA256 (salt, iter) gives an AES-256-GCM key, the nonce
# is iv, and their lowercased name is the associated data. app.js unlocks it the same way when they log in.
# The token file holds just the token; it is never printed.
import base64
import hashlib
import json
import os
import sys

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

ITERATIONS = 250000
FILE = "users.json"


def lock(name, password, token):
    salt, iv = os.urandom(16), os.urandom(12)
    key = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS, 32)
    sealed = AESGCM(key).encrypt(iv, token.encode(), name.lower().encode())
    b64 = lambda b: base64.b64encode(b).decode()
    return {"name": name, "salt": b64(salt), "iter": ITERATIONS, "iv": b64(iv), "key": b64(sealed)}


def main():
    if len(sys.argv) != 4:
        sys.exit(__doc__ or "usage: users.py TOKEN_FILE NAME PASSWORD")
    token_file, name, password = sys.argv[1:]
    token = open(token_file).read().strip()
    users = json.load(open(FILE)) if os.path.exists(FILE) else {"users": []}
    entry = lock(name, password, token)
    for i, u in enumerate(users["users"]):
        if u["name"].lower() == name.lower():
            users["users"][i] = dict(u, **entry)  # keeps other settings such as "admin"
            break
    else:
        users["users"].append(entry)
    with open(FILE, "w") as f:
        f.write(json.dumps(users, ensure_ascii=False, indent=1) + "\n")
    print(f"{name}: saved in {FILE} ({len(users['users'])} players)")


if __name__ == "__main__":
    main()
