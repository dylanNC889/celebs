#!/usr/bin/env python3
# Test fixtures for tests/run.sh: users.json with three test players (Akimei is an admin) whose passwords are
# "<Name>-test-pw", all unlocking the fake token "dummy-token-for-tests", plus a fake Gemini key. Uses the
# repo's own tools/users.py and tools/ai-key.py, so the browser code is tested against what they write.
#   python3 tests/make-fixtures.py REPO_DIR WORK_DIR
import json
import os
import subprocess
import sys

repo, work = os.path.abspath(sys.argv[1]), os.path.abspath(sys.argv[2])
token, ai = os.path.join(work, "fake-token"), os.path.join(work, "fake-ai-key")
open(token, "w").write("dummy-token-for-tests\n")
open(ai, "w").write("fake-gemini-key\n")
users = os.path.join(work, "users.json")
if os.path.exists(users):
    os.remove(users)
for name in ["Akimei", "Cheezie", "Kyndemoo"]:
    subprocess.run([sys.executable, os.path.join(repo, "tools", "users.py"), token, name, name + "-test-pw"], cwd=work, check=True, stdout=subprocess.DEVNULL)
data = json.load(open(users))
data["users"][0]["admin"] = True
open(users, "w").write(json.dumps(data, indent=1) + "\n")
subprocess.run([sys.executable, os.path.join(repo, "tools", "ai-key.py"), token, ai], cwd=work, check=True, stdout=subprocess.DEVNULL)
os.remove(token)
os.remove(ai)
print("fixtures ready in", work)
