import { ApiClient } from "./apiClient";

/**
 * Client-side helper that reads badge state via the backend. The backend
 * owns the Firebase Admin SDK credentials, so this class simply wraps the
 * relevant HTTP calls.
 */
export class FirebaseClient {
  constructor(private api: ApiClient) {}

  async getBadges(): Promise<string[]> {
    return this.api.getBadges();
  }
}
