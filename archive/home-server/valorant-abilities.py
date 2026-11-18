# Builds a manage.py load file with Valorant abilities and ability types from valorant-api.com's agent
# data (the game's current ability text). Run after a new agent or ability rework, check the review
# table it prints to stderr, then load the file:
#   python3 -I valorant-abilities.py > /root/abilities.json && python3 -I manage.py load /root/abilities.json
# Pass a saved agents.json instead to work offline. Ability types come from the RULES below plus EXTRA.
import json
import re
import sys
import urllib.request

API = "https://valorant-api.com/v1/agents?isPlayableCharacter=true&language=en-US"

SLOTS = {"Grenade": "C", "Ability1": "Q", "Ability2": "E", "Ultimate": "X, ultimate", "Passive": "passive"}
ORDER = list(SLOTS)

# Ability types: (tag, pattern searched in the cleaned, lower-cased description of each ability)
RULES = [
    ("Smoke", r"smoke|vision-blocking (cloud|cylinder)"),
    ("Wall", r"(?<!through a )wall|barriers"),
    ("Flash", r"flash|blind"),
    ("Nearsight", r"nearsight"),
    ("Concuss", r"concuss"),
    ("Slow", r"\bslow(s|ing|ly)?\b|hinder"),
    # skips shields ("instance of damage"), immunity, "upon taking (lethal) damage" and "damaging assist"
    ("Damage", r"(?<!instance of )(?<!taking )(?<!debuffs and )(?<!lethal )\b(lethal )?damag(e|ing)\b(?! assist)"),
    ("Trap", r"\btriggers\b"),
    ("Teleport", r"teleport|travel to it"),
    ("Movement", r"dash|propel|slide|glide"),
    ("Heal", r"\b(over)?heal(s|ing)?\b"),
    ("Revive", r"resurrect"),
    ("Suppress", r"suppress"),
    ("Bots & creatures", r"\bchases\b|take control"),
]
# Info: how an agent learns where enemies are. Pings show enemies' positions (Sova, Fade);
# alarms tell you someone is coming (Killjoy, Deadlock): devices that trigger, play an audio cue or shoot;
# drones are things you steer or send ahead to find enemies (Sova's owl, Skye's dog, Gekko's Wingman).
INFO = [
    ("Pings", r"reveal|snapshot|\bmarks?\b|location tracked"),
    ("Alarms", r"\btriggers\b|audio cue|shoots at enemies"),
    ("Drones", r"take control|send it forward\..{0,80}chases|send out up to three seekers"),
]
# Hand additions where the description wording misses a well-known effect
EXTRA = {
    "Raze": {"Movement"},  # Blast Pack knocks Raze herself away too: the satchel jump
}


def clean(text):
    text = re.sub(r"<[^>]*>", "", text)
    text = re.sub(r"(?<![/\w])[A-Z]{2,}(?:\s[A-Z]{2,})*(?![/\w])", lambda m: m.group(0).lower(), text)
    text = " ".join(part.strip() for part in text.splitlines() if part.strip())
    text = re.sub(r"\s+", " ", text).strip()
    return re.sub(r"(^|[.!?]\s+)([a-z])", lambda m: m.group(1) + m.group(2).upper(), text)


def title(name):
    return name.title() if name.isupper() else name


if len(sys.argv) > 1:
    agents = json.load(open(sys.argv[1], encoding="utf-8"))["data"]
else:
    with urllib.request.urlopen(API, timeout=30) as reply:
        agents = json.load(reply)["data"]
entries, review = [], []
for agent in sorted(agents, key=lambda a: a["displayName"].lower()):
    lines, tags, info, why = [], set(EXTRA.get(agent["displayName"], ())), set(), {}
    for ability in sorted(agent["abilities"], key=lambda x: ORDER.index(x["slot"])):
        text = clean(ability["description"])
        name = title(ability["displayName"])
        lines.append(f"{name} ({SLOTS[ability['slot']]}): {text}")
        for group, rules in ((tags, RULES), (info, INFO)):
            for tag, pattern in rules:
                if re.search(pattern, text.lower()):
                    group.add(tag)
                    why.setdefault(tag, []).append(name)
    ordered = [t for t, _ in RULES if t in tags]
    info = [t for t, _ in INFO if t in info]
    entries.append({"name": agent["displayName"], "Abilities": lines, "Ability types": ordered, "Info": info})
    review.append(f"{agent['displayName']:10} " + "; ".join(f"{t}<{','.join(why.get(t, ['hand']))}>" for t in ordered + info))

json.dump({"Valorant": {"entries": entries}}, sys.stdout, ensure_ascii=False, indent=1)
print("\n".join(review), file=sys.stderr)
counts = {t: sum(t in e["Ability types"] + e["Info"] for e in entries) for t, _ in RULES + INFO}
print(counts, file=sys.stderr)
