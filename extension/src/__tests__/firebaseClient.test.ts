import { ApiClient } from "../apiClient";
import { FirebaseClient } from "../firebaseClient";

function makeTokens() {
  return {
    getIdToken: jest.fn(async (force?: boolean) => (force ? "fresh-token" : "stale-token")),
  };
}

describe("FirebaseClient.getBadges", () => {
  it("delegates to ApiClient.getBadges", async () => {
    const api = new ApiClient("http://localhost:8000", makeTokens());
    const spy = jest.spyOn(api, "getBadges").mockResolvedValue(["First Question"]);
    const firebase = new FirebaseClient(api);

    const badges = await firebase.getBadges();

    expect(spy).toHaveBeenCalledWith();
    expect(badges).toEqual(["First Question"]);
  });

  it("returns empty array when ApiClient.getBadges returns empty", async () => {
    const api = new ApiClient("http://localhost:8000", makeTokens());
    jest.spyOn(api, "getBadges").mockResolvedValue([]);
    const firebase = new FirebaseClient(api);

    const badges = await firebase.getBadges();
    expect(badges).toEqual([]);
  });

  it("propagates errors from ApiClient", async () => {
    const api = new ApiClient("http://localhost:8000", makeTokens());
    jest.spyOn(api, "getBadges").mockRejectedValue(new Error("Network failure"));
    const firebase = new FirebaseClient(api);

    await expect(firebase.getBadges()).rejects.toThrow("Network failure");
  });
});
