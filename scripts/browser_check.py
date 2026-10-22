"""Record actual local ledger operations; no generated telemetry or simulated UI states."""

import json
import os
import time
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

for line in Path(".env").read_text().splitlines():
    key, value = line.split("=", 1)
    os.environ[key] = value
out = Path("docs/results")
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=os.getenv("CHROMIUM_PATH"))
    context = browser.new_context(
        viewport={"width": 1440, "height": 1000},
        record_video_dir=str(out / "recordings"),
        record_video_size={"width": 1440, "height": 1000},
    )
    page = context.new_page()
    errors: list[str] = []
    page.on("pageerror", lambda error: errors.append(str(error)))
    started = time.monotonic()
    page.goto("http://127.0.0.1:8084")
    page.get_by_label("Operator password").fill(os.environ["TALLY_PASSWORD"])
    page.get_by_role("button", name="Sign in", exact=False).click()
    expect(page.get_by_text("Database connected", exact=False)).to_be_visible()
    key = "browser_" + str(int(time.time()))
    page.get_by_label("Idempotency key").fill(key)
    page.get_by_role("button", name="Post transfer", exact=True).click()
    expect(page.locator(".result").first).to_contain_text("Committed")
    page.wait_for_timeout(4000)
    page.get_by_role("button", name="Post transfer", exact=True).click()
    expect(page.locator(".result").first).to_contain_text("Idempotent replay")
    page.wait_for_timeout(5000)
    page.get_by_role("button", name="Inject one-cent imbalance", exact=False).click()
    expect(page.get_by_role("alert")).to_contain_text("invalid_input")
    page.wait_for_timeout(5000)
    page.get_by_role("button", name="Verify journal", exact=True).click()
    expect(page.locator(".verification")).to_contain_text("Replay matches balances")
    page.screenshot(path=str(out / "console-desktop.png"), full_page=True)
    page.wait_for_timeout(5000)
    page.get_by_role("button", name="Decisions", exact=False).first.click()
    page.get_by_label("Maximum risk points").fill("60")
    page.get_by_role("button", name="Publish immutable rules").click()
    expect(page.locator(".result")).to_contain_text("Published")
    page.get_by_label("Decision request ID").fill("decision_" + key)
    page.get_by_role("button", name="Evaluate request").click()
    expect(page.locator(".decision").first).to_contain_text("Approved by demo rules")
    page.wait_for_timeout(5000)
    page.get_by_label("Maximum risk points").fill("20")
    with page.expect_response(
        lambda r: r.url.endswith("/api/rules") and r.request.method == "POST"
    ):
        page.get_by_role("button", name="Publish immutable rules").click()
    page.get_by_role("button", name="New request ID").click()
    page.get_by_role("button", name="Evaluate request").click()
    expect(page.locator(".decision").first).to_contain_text("Declined by demo rules")
    page.get_by_role("button", name="Replay stored decisions").click()
    expect(page.locator(".decision-replay")).to_contain_text("Exact replays:")
    page.wait_for_timeout(6000)
    page.get_by_role("button", name="Reconciliation", exact=False).first.click()
    expect(page.get_by_role("heading", name="Exception queue")).to_be_visible()
    review = page.locator('[data-bank="bank_19"]')
    expect(review).to_be_visible()
    review.get_by_label("Ledger selection").select_option(index=1)
    review.get_by_role("button", name="Resolve bank_19").click()
    expect(review).to_have_count(0)
    page.screenshot(path=str(out / "console-reconciliation.png"), full_page=True)
    page.wait_for_timeout(6000)
    page.get_by_role("button", name="Data health", exact=False).first.click()
    page.get_by_role("button", name="Enrich descriptor").click()
    expect(page.locator(".enrichment")).to_contain_text("Synthetic Juniper Cafe")
    page.get_by_role("button", name="Enrich descriptor").click()
    expect(page.locator(".enrichment")).to_contain_text("hits")
    expect(page.locator(".feed").filter(has_text="synthetic_market_feed")).to_contain_text(
        "future timestamp"
    )
    page.wait_for_timeout(7000)
    page.get_by_role("button", name="Audit trail", exact=False).first.click()
    expect(page.locator(".timeline")).to_contain_text("exception resolved")
    page.wait_for_timeout(7000)
    page.reload()
    expect(page.get_by_text("Database connected", exact=False)).to_be_visible()
    page.get_by_role("button", name="Verify journal", exact=True).click()
    expect(page.locator(".verification")).to_contain_text("Replay matches balances")
    while time.monotonic() - started < 91:
        page.wait_for_timeout(min(5, 91 - (time.monotonic() - started)) * 1000)
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(500)
    assert page.evaluate("document.documentElement.scrollWidth<=window.innerWidth")
    page.screenshot(path=str(out / "console-mobile.png"), full_page=True)
    assert not errors, errors
    elapsed = time.monotonic() - started
    video = page.video
    context.close()
    video.save_as(str(out / "demo.webm"))
    browser.close()
(out / "browser.json").write_text(
    json.dumps(
        {
            "page_errors": errors,
            "elapsed_seconds": elapsed,
            "posted_and_idempotent_replay": True,
            "one_cent_imbalance_rejected": True,
            "journal_replay_equal": True,
            "immutable_rule_version_changed_outcome": True,
            "decisions_replayed": True,
            "manual_exception_resolved": True,
            "descriptor_enriched": True,
            "future_feed_timestamp_visible": True,
            "reload_persisted": True,
            "mobile_no_overflow": True,
            "scope": "Actual local NestJS API and Postgres; no simulated counters",
        },
        indent=2,
    )
    + "\n"
)
print("Actual console posting, decisions, review and responsive checks passed.")
