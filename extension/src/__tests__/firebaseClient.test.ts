import { ApiClient } from "../apiClient";
import { FirebaseClient } from "../firebaseClient";

describe("FirebaseClient.getBadges", () => {
  it("delegates to ApiClient.getBadges", async () => {
    const api = new ApiClient("http://localhost:8000");
    const spy = jest.spyOn(api, "getBadges").mockResolvedValue(["First Question"]);
    const firebase = new FirebaseClient(api);

    const badges = await firebase.getBadges("u1");

    expect(spy).toHaveBeenCalledWith("u1");
    expect(badges).toEqual(["First Question"]);
  });

  it("returns empty array when ApiClient.getBadges returns empty", async () => {
    const api = new ApiClient("http://localhost:8000");
    jest.spyOn(api, "getBadges").mockResolvedValue([]);
    const firebase = new FirebaseClient(api);

    const badges = await firebase.getBadges("u1");
    expect(badges).toEqual([]);
  });

  it("propagates errors from ApiClient", async () => {
    const api = new ApiClient("http://localhost:8000");
    jest.spyOn(api, "getBadges").mockRejectedValue(new Error("Network failure"));
    const firebase = new FirebaseClient(api);

    await expect(firebase.getBadges("u1")).rejects.toThrow("Network failure");
  });
});
