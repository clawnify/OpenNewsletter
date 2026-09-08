import { describe, expect, it } from "vitest";
import { crmConfigured, crmProxyUrl, pickIds, unwrapContact, validateEvidence, MAX_IMPORT } from "./crm";

describe("crm", () => {
  it("is connected only when both the app id and the org token are present", () => {
    expect(crmConfigured({})).toBe(false);
    expect(crmConfigured({ CRM_APP_ID: "abc" })).toBe(false);
    expect(crmConfigured({ CLAWNIFY_TOKEN: "clw_x" })).toBe(false);
    expect(crmConfigured({ CRM_APP_ID: " abc ", CLAWNIFY_TOKEN: "clw_x" })).toBe(true);
  });

  it("routes every read through the platform proxy for that app", () => {
    expect(crmProxyUrl("app-1", "/api/contacts?page=2")).toBe(
      "https://provision.clawnify.com/v1/apps/app-1/proxy/api/contacts?page=2",
    );
    expect(crmProxyUrl("a/b", "api/x")).toBe("https://provision.clawnify.com/v1/apps/a%2Fb/proxy/api/x");
  });

  it("refuses evidence that is not really evidence", () => {
    expect(validateEvidence("ok")).toBeNull();
    expect(validateEvidence("   ")).toBeNull();
    expect(validateEvidence(42)).toBeNull();
    expect(validateEvidence("Signed order form, clause 7, 2026-03-01")).toBe(
      "Signed order form, clause 7, 2026-03-01",
    );
  });

  it("bounds and dedupes the selection", () => {
    expect(pickIds([])).toBeNull();
    expect(pickIds("x")).toBeNull();
    expect(pickIds(["a", " a ", "b", 3, ""])).toEqual(["a", "b"]);
    expect(pickIds(Array.from({ length: MAX_IMPORT + 1 }, (_, i) => `c${i}`))).toBeNull();
  });

  it("unwraps the CRM's { contact } envelope and rejects anything without an id", () => {
    const row = { id: "c1", first_name: "Ada", last_name: "Lovelace", email: "ada@example.com" };
    expect(unwrapContact({ contact: row })).toEqual(row);
    expect(unwrapContact(row)).toEqual(row);
    expect(unwrapContact({ error: "Not found" })).toBeNull();
    expect(unwrapContact(null)).toBeNull();
  });
});
