import { describe, expect, it } from "vitest";
import { dmarcCheck, domainCheck, findDmarc, GMAIL_CLIP_BYTES, imagesCheck, sizeCheck } from "./preflight";
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
    expect(domainCheck("example.com", d, [{ record: "SPF", status: "verified" }, { record: "DKIM", status: "pending" }]))
      .toMatchObject({ level: "warn", detail: expect.stringContaining("DKIM not verified") });
  });

  // Resend: with two sending records, one verified is enough to send; the other is a fallback.
  it("is fine with one of two sending records verified, and with receiving pending", () => {
    const d = { name: "example.com", status: "partially_verified" };
    const recs = [
      { record: "SPF", status: "verified" }, { record: "SPF", status: "pending" },
      { record: "DKIM", status: "verified" }, { record: "Receiving", status: "pending" },
    ];
    expect(domainCheck("example.com", d, recs).level).toBe("ok");
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

  it("ignores other TXT records, discards two DMARC records at one name, never asks the TLD", async () => {
    const d = dns({
      "_dmarc.a.example.com": ["v=spf1 -all", "v=DMARC1; p=none", "v=DMARC1; p=reject"],
      "_dmarc.example.com": ["some-verification=1", "v=DMARC1; p=quarantine"],
    });
    expect((await findDmarc("a.example.com", d.resolve))?.tags.p).toBe("quarantine");
    const none = dns({});
    expect(await findDmarc("a.b.example.com", none.resolve)).toBeNull();
    expect(none.asked).toEqual(["_dmarc.a.b.example.com", "_dmarc.b.example.com", "_dmarc.example.com"]);
  });

  it("stops after 8 lookups", async () => {
    const d = dns({});
    await findDmarc("a.b.c.d.e.f.g.h.i.j.example.com", d.resolve);
    expect(d.asked).toHaveLength(8);
  });

  it("warns with the record to add when there is none, at the signing domain", () => {
    const c = dmarcCheck("news.example.com", "example.com", null);
    expect(c.level).toBe("warn");
    expect(c.record).toEqual({ name: "_dmarc.example.com", type: "TXT", value: "v=DMARC1; p=none;" });
  });

  it("fails strict alignment for a subdomain sender under an enforcing policy", () => {
    const rec = { at: "example.com", tags: { v: "DMARC1", p: "reject", adkim: "s" } };
    expect(dmarcCheck("news.example.com", "example.com", rec).level).toBe("fail");
    expect(dmarcCheck("example.com", "example.com", rec).level).toBe("ok");
    expect(dmarcCheck("news.example.com", "example.com", { ...rec, tags: { ...rec.tags, p: "none" } }).level).toBe("ok");
  });

  it("says unknown when DNS can't be reached", () => {
    expect(dmarcCheck("example.com", "example.com", "error").level).toBe("unknown");
  });
});

describe("content", () => {
  it("warns at Gmail's clip size, counting bytes not characters", () => {
    expect(sizeCheck("a".repeat(GMAIL_CLIP_BYTES - 1), false).level).toBe("ok");
    expect(sizeCheck("a".repeat(GMAIL_CLIP_BYTES), false).level).toBe("warn");
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
