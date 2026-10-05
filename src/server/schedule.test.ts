import { describe, expect, it } from "vitest";
import { parseScheduleTime, sendVerdict } from "./schedule";

const AT = "2026-08-01T09:00:00.000Z";
const LATER = "2026-08-01T17:00:00.000Z";

describe("sendVerdict", () => {
  it("sends when the mail still points at this job's time", () => {
    expect(sendVerdict({ status: "scheduled", scheduled_at: AT }, AT)).toEqual({ send: true });
  });

  // The one that matters most: delivery is at-least-once, so a send whose
  // outcome was never recorded arrives again. Without this the whole list is
  // mailed twice.
  it("refuses a redelivery of a mail that already went out", () => {
    expect(sendVerdict({ status: "sent", scheduled_at: null }, AT)).toEqual({
      send: false,
      reason: "already-sent",
    });
  });

  it("still refuses an already-sent mail that somehow kept its scheduled_at", () => {
    // Guards the status independently of the timestamp, so this does not rely
    // on sending clearing scheduled_at.
    expect(sendVerdict({ status: "sent", scheduled_at: AT }, AT).send).toBe(false);
  });

  it("refuses a mail pulled back to draft after it was scheduled", () => {
    expect(sendVerdict({ status: "draft", scheduled_at: null }, AT)).toEqual({
      send: false,
      reason: "not-scheduled",
    });
  });

  // Rescheduling cannot cancel the old job — the platform's idempotency row
  // survives cancellation — so the 09:00 job WILL fire after a move to 17:00.
  it("refuses the old job after a reschedule, and lets the new one through", () => {
    const moved = { status: "scheduled", scheduled_at: LATER };
    expect(sendVerdict(moved, AT)).toEqual({ send: false, reason: "superseded" });
    expect(sendVerdict(moved, LATER)).toEqual({ send: true });
  });

  it("refuses when the mail has no schedule at all", () => {
    expect(sendVerdict({ status: "scheduled", scheduled_at: null }, AT).send).toBe(false);
  });

  // Jobs already queued when this guard ships carry no scheduled_for.
  describe("legacy jobs with no scheduled_for (null)", () => {
    it("still sends — dropping them would silently lose a scheduled issue", () => {
      expect(sendVerdict({ status: "scheduled", scheduled_at: AT }, null)).toEqual({ send: true });
    });

    it("but is still refused once the issue has gone out", () => {
      expect(sendVerdict({ status: "sent", scheduled_at: null }, null)).toEqual({
        send: false,
        reason: "already-sent",
      });
    });

    it("and is still refused if it was pulled back to draft", () => {
      expect(sendVerdict({ status: "draft", scheduled_at: null }, null).send).toBe(false);
    });
  });

  it("compares timestamps exactly — a differently formatted same instant is not a match", () => {
    // Both sides originate from the same `new Date(x).toISOString()` call, so
    // exact compare is correct. Pinned as a test because loosening this to a
    // parsed comparison would let a stale job match a rescheduled mail.
    expect(sendVerdict({ status: "scheduled", scheduled_at: "2026-08-01T09:00:00Z" }, AT).send).toBe(false);
  });
});

describe("parseScheduleTime", () => {
  const NOW = Date.parse("2026-10-05T10:00:00Z");

  // The send dialog used to post the bare datetime-local value. A Worker
  // parses that as UTC, so 14:00 picked in Amsterdam went out at 16:00 there.
  it("refuses a time without a timezone", () => {
    expect(parseScheduleTime("2026-10-05T14:00", NOW).ok).toBe(false);
    expect(parseScheduleTime("2026-10-05 14:00", NOW).ok).toBe(false);
    expect(parseScheduleTime(undefined, NOW).ok).toBe(false);
  });

  it("reads the offset it is given", () => {
    expect(parseScheduleTime("2026-10-05T14:00+02:00", NOW)).toEqual({ ok: true, iso: "2026-10-05T12:00:00.000Z" });
    expect(parseScheduleTime("2026-10-05T12:00:00.000Z", NOW)).toEqual({ ok: true, iso: "2026-10-05T12:00:00.000Z" });
  });

  it("refuses a time that has passed, allowing a minute for a slow click", () => {
    expect(parseScheduleTime("2026-10-05T09:58:00Z", NOW).ok).toBe(false);
    expect(parseScheduleTime("2026-10-05T09:59:30Z", NOW).ok).toBe(true);
  });

  it("refuses a date that does not exist", () => {
    expect(parseScheduleTime("2026-02-30T10:00:00Z", NOW).ok).toBe(false);
  });
});
