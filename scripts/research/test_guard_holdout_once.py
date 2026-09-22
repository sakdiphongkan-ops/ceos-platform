import json, subprocess, tempfile
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]
GUARD=ROOT/"scripts/research/guard_holdout_once.py"

with tempfile.TemporaryDirectory() as d:
    p=Path(d)
    result=p/"result.json"
    marker=p/"marker.json"

    opened=subprocess.run([
        "python",str(GUARD),
        "--marker",str(marker),
        "--result",str(result),
        "--protocol","TEST"
    ],capture_output=True,text=True)
    assert opened.returncode==0
    assert '"status": "OPEN"' in opened.stdout

    result.write_text(json.dumps({"status":"COMPLETED"}),encoding="utf-8")
    subprocess.run([
        "python",str(GUARD),
        "--marker",str(marker),
        "--result",str(result),
        "--protocol","TEST",
        "--mode","seal"
    ],check=True)

    blocked=subprocess.run([
        "python",str(GUARD),
        "--marker",str(marker),
        "--result",str(result),
        "--protocol","TEST"
    ],capture_output=True,text=True)
    assert blocked.returncode==2
    assert "HOLDOUT_ALREADY_SEALED" in blocked.stdout
print("holdout one-shot guard test: PASS")
