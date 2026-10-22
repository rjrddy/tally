"""Anonymous production verification of recorded evidence, without a bypass token."""

import json
import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

url = os.getenv("TALLY_PUBLIC_URL", "https://tally-gamma-lac.vercel.app")
expected = float(json.loads(Path("docs/results/demo-probe.json").read_text())["format"]["duration"])
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.getenv("CHROMIUM_PATH"))
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    errors: list[str] = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    response = page.goto(url)
    assert response and response.status == 200
    expect(page.get_by_role("heading", name="Every cent has a history.")).to_be_visible()
    expect(page.locator("#metrics article")).to_have_count(3)
    expect(page.locator("#latencies tr")).to_have_count(3)
    page.get_by_role("tab", name="Lost response", exact=True).click()
    expect(page.locator("#fault pre")).to_contain_text('"replayed": true')
    page.get_by_role("tab", name="Projection drift", exact=True).click()
    expect(page.locator("#fault")).to_contain_text("bench_a")
    expect(page.locator("#recording")).to_contain_text(f"{expected:.2f} seconds")
    video = page.locator("video")
    video.scroll_into_view_if_needed()
    video.evaluate("v=>v.play()")
    page.wait_for_function('document.querySelector("video").currentTime>0')
    duration = video.evaluate("v=>v.duration")
    assert duration >= 90
    page.evaluate("window.scrollTo(0,0)")
    page.screenshot(path="docs/results/site-desktop.png", full_page=True)
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(250)
    assert page.evaluate("document.documentElement.scrollWidth<=window.innerWidth")
    page.screenshot(path="docs/results/site-mobile.png", full_page=True)
    proof = page.request.get(url + "/proof.json")
    assert proof.status == 200
    assert proof.json()["ledger"]["replay"]["events"] == 1003
    assert not errors, errors
    browser.close()
Path("docs/results/site.json").write_text(
    json.dumps(
        {
            "url": url,
            "anonymous_http_status": response.status,
            "page_errors": errors,
            "measurement_cards": 3,
            "latency_rows": 3,
            "recorded_fault_tabs_work": True,
            "video_played": True,
            "video_duration_seconds": duration,
            "mobile_no_overflow": True,
            "proof_http_status": proof.status,
            "scope": "Static measured evidence and actual recording; persistent API not hosted",
        },
        indent=2,
    )
    + "\n"
)
print("Anonymous site, evidence controls, video playback and mobile layout passed.")
