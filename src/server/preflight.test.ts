import { afterEach, describe, expect, it, vi } from "vitest";
import { CLIP_MARGIN_BYTES, dmarcCheck, dohTxt, domainCheck, findDmarc, GMAIL_CLIP_BYTES, imagesCheck, sizeCheck } from "./preflight";
import { sendableStatus, signingDomain } from "../shared/sending-domain";

describe("sending domain", () => {
  it("can send from a partially verified domain, not from one Resend hasn't verified", () => {
    expect(sendableStatus("verified")).toBe(true);
    expect(sendableStatus("partially_verified")).toBe(true);
    expect(sendableStatus("partially_failed")).toBe(true);
    for (const s of ["not_started", "pending", "failed"]) expect(sendableStatus(s)).toBe(false);
  });

  it("picks the closest domain that covers the From address", () => {
    const ds = [{ name: "example.com" }, { name: "news.example.com" }, { name: "other.com" }];
    expect(signingDomain("news.example.com", ds)?.name).toBe("news.example.com");
    expect(signingDomain("mail.example.com", ds)?.name).toBe("example.com");
    expect(signingDomain("notexample.com", ds)).toBeNull();
  });

  it("fails a From domain that isn't on the account, warns on DKIM not verified", () => {
    expect(domainCheck("x.com", null, null).level).toBe("fail");
    const d = { name: "example.com", status: "partially_verified" };
    expect(domainCheck("example.com", d, [{ record: "SPF", type: "TXT", status: "verified" }, { record: "DKIM", type: "TXT", status: "pending" }]))
      .toMatchObject({ level: "warn", detail: expect.stringContaining("DKIM not verified") });
  });

  // Resend: older domains' SPF is a TXT and an MX, both needed. Newer ones get
  // two CNAMEs, and one verified is enough to send (the other is a fallback).
  it("needs both legacy SPF records, but only one of two CNAMEs; receiving doesn't count", () => {
    const d = { name: "example.com", status: "partially_verified" };
    const dkim = { record: "DKIM", type: "TXT", status: "verified" };
    const legacy = [{ record: "SPF", type: "MX", status: "verified" }, { record: "SPF", type: "TXT", status: "failed" }, dkim];
    expect(domainCheck("example.com", d, legacy)).toMatchObject({ level: "warn", detail: expect.stringContaining("SPF not verified") });
    const cnames = [
      { record: "SPF", type: "CNAME", status: "verified" }, { record: "SPF", type: "CNAME", status: "pending" },
      dkim, { record: "Receiving", type: "MX", status: "pending" },
    ];
    expect(domainCheck("example.com", d, cnames).level).toBe("ok");
  });

  it("never passes a partly verified domain whose records couldn't be read", () => {
    expect(domainCheck("example.com", { name: "example.com", status: "partially_failed" }, null).level).toBe("unknown");
    expect(domainCheck("example.com", { name: "example.com", status: "verified" }, null).level).toBe("ok");
  });
});

describe("DMARC", () => {
  const dns = (records: Record<string, string[]>) => {
    const asked: string[] = [];
    const resolve = async (name: string) => { asked.push(name); return records[name] || []; };
    return { resolve, asked };
  };

  it("uses the From domain's own record first, then the nearest parent's", async () => {
    const own = dns({ "_dmarc.news.example.com": ["v=DMARC1; p=reject"], "_dmarc.example.com": ["v=DMARC1; p=none"] });
    expect((await findDmarc("news.example.com", own.resolve))?.tags.p).toBe("reject");
    const parent = dns({ "_dmarc.example.com": ["v=DMARC1; p=quarantine; sp=none"] });
    const found = await findDmarc("news.example.com", parent.resolve);
    expect(found?.at).toBe("example.com");
    // A parent's record applies its subdomain policy.
    expect(dmarcCheck("news.example.com", "example.com", found!)).toMatchObject({ level: "ok", detail: expect.stringContaining("p=none") });
  });

  it("ignores other TXT records, discards two DMARC records at one name, walks up to the TLD", async () => {
    const d = dns({
      "_dmarc.a.example.com": ["v=spf1 -all", "v=DMARC1; p=none", "v=DMARC1; p=reject"],
      "_dmarc.example.com": ["some-verification=1", "v=DMARC1; p=quarantine"],
    });
    expect((await findDmarc("a.example.com", d.resolve))?.tags.p).toBe("quarantine");
    const none = dns({});
    expect(await findDmarc("a.b.example.com", none.resolve)).toBeNull();
    expect(none.asked).toEqual(["_dmarc.a.b.example.com", "_dmarc.b.example.com", "_dmarc.example.com", "_dmarc.com"]);
  });

  // RFC 9989: after the first query, a name of more than 8 labels jumps to its last 7.
  it("reaches the parent of a deep name in at most 8 lookups", async () => {
    const d = dns({ "_dmarc.example.com": ["v=DMARC1; p=none"] });
    const found = await findDmarc("a.b.c.d.e.f.g.h.i.j.example.com", d.resolve);
    expect(found?.at).toBe("example.com");
    expect(d.asked[0]).toBe("_dmarc.a.b.c.d.e.f.g.h.i.j.example.com");
    expect(d.asked[1]).toBe("_dmarc.f.g.h.i.j.example.com");
    const none = dns({});
    await findDmarc("a.b.c.d.e.f.g.h.i.j.example.com", none.resolve);
    expect(none.asked).toHaveLength(8);
  });

  it("warns with the record to add when there is none, at the signing domain", () => {
    const c = dmarcCheck("news.example.com", "example.com", null);
    expect(c.level).toBe("warn");
    expect(c.record).toEqual({ name: "_dmarc.example.com", type: "TXT", value: "v=DMARC1; p=none;" });
  });

  // DMARC passes on either aligned DKIM or aligned SPF. Resend bounces through
  // send.<domain>, which relaxed SPF alignment accepts for a subdomain sender.
  it("fails only when DKIM and SPF are both strict, for a subdomain sender under an enforcing policy", () => {
    const dkimOnly = { at: "example.com", tags: { v: "DMARC1", p: "reject", adkim: "s" } };
    expect(dmarcCheck("news.example.com", "example.com", dkimOnly).level).toBe("ok");
    const rec = { at: "example.com", tags: { v: "DMARC1", p: "reject", adkim: "s", aspf: "s" } };
    expect(dmarcCheck("news.example.com", "example.com", rec).level).toBe("fail");
    expect(dmarcCheck("example.com", "example.com", rec).level).toBe("ok");
    expect(dmarcCheck("news.example.com", "example.com", { ...rec, tags: { ...rec.tags, p: "none" } }).level).toBe("ok");
  });

  describe("over DNS-over-HTTPS", () => {
    afterEach(() => vi.unstubAllGlobals());
    const answer = (data: string, Status = 0) =>
      vi.stubGlobal("fetch", async () => Response.json({ Status, Answer: Status ? undefined : [{ type: 5, data: "x." }, { type: 16, data }] }));

    it("joins split strings and decodes escapes", async () => {
      answer(String.raw`"v=DMARC1\059 p=none; rua=mailto:a@x.y" "; ruf=\"q\""`);
      expect(await dohTxt("_dmarc.x.y")).toEqual([`v=DMARC1; p=none; rua=mailto:a@x.y; ruf="q"`]);
    });

    it("reads a missing name as no record, a server failure as an error", async () => {
      answer("", 3);
      expect(await dohTxt("_dmarc.x.y")).toEqual([]);
      answer("", 2);
      await expect(dohTxt("_dmarc.x.y")).rejects.toThrow();
    });
  });

  it("says unknown when DNS can't be reached", () => {
    expect(dmarcCheck("example.com", "example.com", "error").level).toBe("unknown");
  });
});

describe("content", () => {
  it("warns at Gmail's clip size, counting bytes not characters", () => {
    expect(sizeCheck("a".repeat(CLIP_MARGIN_BYTES - 1), false).level).toBe("ok");
    expect(sizeCheck("a".repeat(CLIP_MARGIN_BYTES), false)).toMatchObject({ level: "warn", detail: expect.stringContaining("close to") });
    expect(sizeCheck("a".repeat(GMAIL_CLIP_BYTES), false)).toMatchObject({ level: "warn", detail: expect.stringContaining("Message clipped") });
    // 3 bytes each in UTF-8.
    expect(sizeCheck("€".repeat(Math.ceil(GMAIL_CLIP_BYTES / 3)), false).level).toBe("warn");
    expect(sizeCheck("<p>hi</p>", true).detail).toContain("click tracking");
  });

  it("finds embedded images, not linked ones", () => {
    expect(imagesCheck(`<img src="https://x.y/a.png">`).level).toBe("ok");
    const c = imagesCheck(`<img alt="a" src="data:image/png;base64,AAA"><img src='data:image/gif;base64,B'>`);
    expect(c).toMatchObject({ level: "warn", detail: expect.stringContaining("2 images are embedded") });
  });
});
