import { describe, expect, it } from "vitest";
import { STATION_FOR, detectDelegation } from "./delegation";

describe("detectDelegation", () => {
  it("routes explicit agent mentions (earliest wins)", () => {
    expect(detectDelegation("suruh michelle buatkan test")).toEqual({ agent: "michelle", station: "pc-2" });
    expect(detectDelegation("tanya ke agnes tentang pajak")).toEqual({ agent: "agnes", station: "pc-1" });
    expect(detectDelegation("tanya agnes dan michelle")).toEqual({ agent: "agnes", station: "pc-1" });
    expect(detectDelegation("michelle dan agnes kerjakan ini")).toEqual({ agent: "michelle", station: "pc-2" });
  });

  it("routes strong coding-task signals to michelle", () => {
    expect(detectDelegation("buatkan unit test untuk login")).toEqual({ agent: "michelle", station: "pc-2" });
    expect(detectDelegation("tolong perbaiki error login")).toEqual({ agent: "michelle", station: "pc-2" });
    expect(detectDelegation("commit file README")).toEqual({ agent: "michelle", station: "pc-2" });
    expect(detectDelegation("baca file package.json")).toEqual({ agent: "michelle", station: "pc-2" });
  });

  it("routes deep-dive research signals to agnes", () => {
    expect(detectDelegation("bandingkan golang vs rust")).toEqual({ agent: "agnes", station: "pc-1" });
    expect(detectDelegation("rangkumkan artikel ini")).toEqual({ agent: "agnes", station: "pc-1" });
    expect(detectDelegation("teliti tentang oauth")).toEqual({ agent: "agnes", station: "pc-1" });
    expect(detectDelegation("cari tahu tentang nikel secara mendalam")).toEqual({ agent: "agnes", station: "pc-1" });
  });

  it("never steals pentest turns (pentest exclusion wins)", () => {
    expect(detectDelegation("lakukan pentest di lab cozy")).toBeNull();
    expect(detectDelegation("cek kerentanan server")).toBeNull();
    expect(detectDelegation("perbaiki bug xss di form login")).toBeNull();
  });

  it("stays silent on single-shot asks (no stealing)", () => {
    expect(detectDelegation("")).toBeNull();
    expect(detectDelegation("halo apa kabar")).toBeNull();
    expect(detectDelegation("cuaca jakarta hari ini")).toBeNull();
    expect(detectDelegation("ingetin aku makan jam 7")).toBeNull();
    expect(detectDelegation("putar lagu tulus")).toBeNull();
    expect(detectDelegation("ya")).toBeNull();
    expect(detectDelegation("cari kafe di cipete")).toBeNull();
  });

  it("exposes fixed workstation mapping", () => {
    expect(STATION_FOR).toEqual({ michelle: "pc-2", agnes: "pc-1" });
  });
});
