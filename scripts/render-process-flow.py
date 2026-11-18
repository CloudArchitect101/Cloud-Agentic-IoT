#!/usr/bin/env python3
"""Renders the README's process animation and the step-through page from one list of steps.

  python3 scripts/render-process-flow.py

writes docs/images/process-flow.svg (auto-plays on GitHub, CSS only, no script)
and docs/process/index.html (Prev / Next / Play, arrow keys; served by GitHub Pages).
Edit STEPS, run it again, and commit both files.
"""
import html
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent

# (title, subtitle, caption, where in the repo)
STEPS = [
    ("ESP32 board", "DHT11 + servo",
     "The board reads 31 C. Its own motor starts turning within about 5 s, decided on the board, so it works offline too.",
     "firmware/patient-monitor/"),
    ("AWS IoT Core", "mutual TLS",
     "The reading goes to AWS IoT Core over mutual TLS, with a certificate that lives only on the board.",
     "firmware/libraries/CloudAgenticDevice/"),
    ("patient-vitals", "Lambda",
     "The patient-vitals Lambda stores every reading in DynamoDB and S3, and flags the one that crossed 30 C.",
     "lambda/patient-vitals/"),
    ("Salesforce Case", "Care_Team_Queue",
     "Salesforce saves the flagged reading and opens one Case for the device in the care team's queue.",
     "force-app/main/default/classes/RoomTemperatureCaseService.cls"),
    ("Ward board", "queue indicator",
     "The queue depth goes back to AWS over a SigV4-signed call, and the ward board starts spinning.",
     "lambda/queue-relay/"),
    ("Patient Care Agent", "Agentforce",
     "A nurse asks the Patient Care Agent what the device reports. It reads the device through its actions.",
     "force-app/main/default/aiAuthoringBundles/"),
    ("SOP search", "Bedrock Titan V2",
     "Asked what to do, the agent finds the ward procedure with Bedrock embeddings and cites its SOP ID.",
     "lambda/procedure-search/"),
    ("Escalate + measure", "Case, dashboard",
     "After the nurse confirms, the agent escalates. The Business Value dashboard measures response time and cost.",
     "force-app/main/default/dashboards/"),
]

STEP_SECONDS = 3
W, H = 960, 420
BOX_W, BOX_H = 190, 86
# A snake: left to right on top, right to left below.
XS = [40, 270, 500, 730]
POS = [(x, 50) for x in XS] + [(x, 210) for x in reversed(XS)]


def arrow(i):
    """Path from node i to node i + 1."""
    (x1, y1), (x2, y2) = POS[i], POS[i + 1]
    if y1 == y2:
        if x2 > x1:
            return f"M{x1 + BOX_W} {y1 + BOX_H / 2} H{x2 - 8}"
        return f"M{x1} {y1 + BOX_H / 2} H{x2 + BOX_W + 8}"
    return f"M{x1 + BOX_W / 2} {y1 + BOX_H} V{y2 - 8}"


def nodes_svg(extra_class=""):
    out = []
    for i, (title, sub, _, _) in enumerate(STEPS):
        x, y = POS[i]
        out.append(
            f'<g class="node n{i}{extra_class}">'
            f'<rect x="{x}" y="{y}" width="{BOX_W}" height="{BOX_H}" rx="12"/>'
            f'<rect class="hi" x="{x}" y="{y}" width="{BOX_W}" height="{BOX_H}" rx="12"/>'
            f'<text class="num" x="{x + 16}" y="{y + 26}">{i + 1}</text>'
            f'<text class="t" x="{x + BOX_W / 2}" y="{y + 42}">{html.escape(title)}</text>'
            f'<text class="s" x="{x + BOX_W / 2}" y="{y + 64}">{html.escape(sub)}</text></g>')
    for i in range(len(STEPS) - 1):
        out.append(f'<path class="edge" d="{arrow(i)}" marker-end="url(#arrow)"/>'
                   f'<path class="eh e{i}" d="{arrow(i)}" marker-end="url(#arrowon)"/>')
    return "\n".join(out)


BASE_CSS = """
.bg{fill:#ffffff;stroke:#d0d7de}
.node rect{fill:#f6f8fa;stroke:#8c959f;stroke-width:1.5}
.node text{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;fill:#1f2328}
.node .t{font-size:16px;font-weight:600;text-anchor:middle}
.node .s{font-size:13px;fill:#59636e;text-anchor:middle}
.node .num{font-size:13px;font-weight:700;fill:#59636e}
.edge{fill:none;stroke:#8c959f;stroke-width:2}
#arrow path{fill:#8c959f}
.node .hi{fill:#0969da;fill-opacity:.12;stroke:#0969da;stroke-width:3;opacity:0}
.eh{fill:none;stroke:#0969da;stroke-width:3;opacity:0}
#arrowon path{fill:#0969da}
.on .hi,.eh.on{opacity:1}
.cap{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:16px;fill:#1f2328}
.cap .k{font-weight:700;fill:#0969da}
.title{font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:13px;fill:#59636e;letter-spacing:.08em}
"""

DARK_CSS = """
@media (prefers-color-scheme: dark){
.bg{fill:#0d1117;stroke:#30363d}
.node rect{fill:#161b22;stroke:#6e7681}
.node text,.cap{fill:#e6edf3}
.node .s,.node .num,.title{fill:#9198a1}
.edge{stroke:#6e7681}#arrow path{fill:#6e7681}
.node .hi{fill:#4493f8;fill-opacity:.18;stroke:#4493f8}.cap .k{fill:#4493f8}
.eh{stroke:#4493f8}#arrowon path{fill:#4493f8}
}
"""

DEFS = ('<defs><marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" '
        'orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker>'
        '<marker id="arrowon" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" '
        'orient="auto-start-reverse"><path d="M0 0L10 5L0 10z"/></marker></defs>')


def wrap(text, width=96):
    lines, line = [], ""
    for word in text.split():
        if len(line) + len(word) + 1 > width:
            lines.append(line)
            line = word
        else:
            line = f"{line} {word}".strip()
    return lines + [line]


def render_svg():
    n = len(STEPS)
    total = n * STEP_SECONDS
    share = 100 / n
    css = BASE_CSS + f"""
@keyframes cap{{0%,{share - 0.01:.2f}%{{opacity:1}}{share:.2f}%,100%{{opacity:0}}}}
.c,.hi,.eh{{animation:cap {total}s linear infinite}}
""" + DARK_CSS
    for i in range(n):
        css += f".n{i} .hi,.c{i}{{animation-delay:{i * STEP_SECONDS - total}s}}\n"
        if i < n - 1:
            # The arrow lights up with the step it leads into. Negative delays
            # start every element mid-cycle, so nothing shows before its turn.
            css += f".e{i}{{animation-delay:{(i + 1) * STEP_SECONDS - total}s}}\n"
    caps = []
    for i, (_, _, caption, where) in enumerate(STEPS):
        lines = wrap(caption)
        tspans = "".join(
            f'<tspan x="40" dy="{0 if j == 0 else 22}">{html.escape(l)}</tspan>' for j, l in enumerate(lines))
        caps.append(
            f'<g class="c c{i}"><text class="cap" x="40" y="342"><tspan class="k">Step {i + 1} of {n}</tspan>'
            f'<tspan dx="10">{html.escape(where)}</tspan></text>'
            f'<text class="cap" x="40" y="370">{tspans}</text></g>')
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" '
           f'role="img" aria-label="How a high temperature reading becomes a Case, a spinning ward board and an agent answer">'
           f'<title>Cloud-Agentic-IoT: from a warm sensor to an agent answer</title>'
           f'<style>{css}</style>{DEFS}'
           f'<rect class="bg" x="0.5" y="0.5" width="{W - 1}" height="{H - 1}" rx="14"/>'
           f'<text class="title" x="40" y="32">FROM A WARM SENSOR TO AN AGENT ANSWER</text>'
           f'{nodes_svg()}<line x1="40" x2="{W - 40}" y1="315" y2="315" stroke="#d0d7de"/>'
           f'{"".join(caps)}</svg>\n')
    out = ROOT / "docs/images/process-flow.svg"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(svg)
    return out


def render_html():
    import json
    steps = json.dumps([{"title": t, "caption": c, "where": w} for t, _, c, w in STEPS])
    svg = (f'<svg viewBox="0 0 {W} 310" role="img" aria-label="Process diagram">{DEFS}'
           f'<rect class="bg" x="0.5" y="0.5" width="{W - 1}" height="309" rx="14"/>'
           f'<text class="title" x="40" y="32">FROM A WARM SENSOR TO AN AGENT ANSWER</text>{nodes_svg()}</svg>')
    page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cloud-Agentic-IoT process</title>
<style>
:root{{color-scheme:light dark;--bg:#ffffff;--fg:#1f2328;--muted:#59636e;--accent:#0969da;--line:#d0d7de;--btn:#f6f8fa}}
@media (prefers-color-scheme: dark){{:root{{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--accent:#4493f8;--line:#30363d;--btn:#21262d}}}}
body{{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif}}
main{{max-width:1000px;margin:0 auto;padding:24px 16px}}
h1{{font-size:22px;margin:0 0 4px}} p.lead{{color:var(--muted);margin:0 0 16px}}
svg{{width:100%;height:auto;display:block}}
{BASE_CSS}{DARK_CSS}
.hi,.eh{{transition:opacity .3s}}
.node{{cursor:pointer}}
.panel{{border:1px solid var(--line);border-radius:12px;padding:16px;margin-top:12px;min-height:96px}}
.k{{color:var(--accent);font-weight:700}} code a{{color:var(--accent)}}
.bar{{display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap}}
button{{background:var(--btn);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px 14px;font-size:15px;cursor:pointer}}
button:focus-visible{{outline:2px solid var(--accent)}}
.dots{{display:flex;gap:6px;margin-left:auto}} .dot{{width:10px;height:10px;border-radius:50%;background:var(--line)}} .dot.on{{background:var(--accent)}}
a{{color:var(--accent)}}
</style>
</head>
<body>
<main>
<h1>From a warm sensor to an agent answer</h1>
<p class="lead">Step through the process with the buttons, the arrow keys, or click a box. <a href="../">Docs home</a> · <a href="https://github.com/CloudArchitect101/Cloud-Agentic-IoT">Code on GitHub</a></p>
{svg}
<div class="panel" aria-live="polite"><div><span class="k" id="num"></span></div><p id="cap"></p><div>In the repo: <code><a id="where" target="_blank" rel="noopener"></a></code></div></div>
<div class="bar"><button id="prev">&larr; Prev</button><button id="next">Next &rarr;</button><button id="play">&#9654; Play</button><div class="dots" id="dots"></div></div>
</main>
<script>
const STEPS = {steps};
const REPO = "https://github.com/CloudArchitect101/Cloud-Agentic-IoT/tree/Dev/";
let i = 0, timer = null;
const dots = document.getElementById("dots");
STEPS.forEach(() => dots.appendChild(Object.assign(document.createElement("span"), {{className: "dot"}})));
function show(n) {{
  i = (n + STEPS.length) % STEPS.length;
  document.querySelectorAll(".node").forEach((g, k) => g.classList.toggle("on", k === i));
  document.querySelectorAll(".eh").forEach((e, k) => e.classList.toggle("on", k === i - 1));
  [...dots.children].forEach((d, k) => d.classList.toggle("on", k === i));
  document.getElementById("num").textContent = `Step ${{i + 1}} of ${{STEPS.length}}: ${{STEPS[i].title}}`;
  document.getElementById("cap").textContent = STEPS[i].caption;
  const w = document.getElementById("where");
  w.textContent = STEPS[i].where; w.href = REPO + STEPS[i].where;
}}
function stop() {{ clearInterval(timer); timer = null; document.getElementById("play").innerHTML = "&#9654; Play"; }}
document.getElementById("prev").onclick = () => {{ stop(); show(i - 1); }};
document.getElementById("next").onclick = () => {{ stop(); show(i + 1); }};
document.getElementById("play").onclick = () => {{
  if (timer) return stop();
  document.getElementById("play").innerHTML = "&#10074;&#10074; Pause";
  timer = setInterval(() => show(i + 1), {STEP_SECONDS * 1000});
}};
document.querySelectorAll(".node").forEach((g, k) => g.addEventListener("click", () => {{ stop(); show(k); }}));
document.addEventListener("keydown", e => {{
  if (e.key === "ArrowRight") {{ stop(); show(i + 1); }}
  if (e.key === "ArrowLeft") {{ stop(); show(i - 1); }}
}});
show(0);
</script>
</body>
</html>
"""
    out = ROOT / "docs/process/index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)
    return out


if __name__ == "__main__":
    for path in (render_svg(), render_html()):
        print(path.relative_to(ROOT))
