// @module verification
// @role retained-fixture
import app, { RateLimiter, WorkspaceHub } from "../../src/apps/worker";

// These synthetic inspection/seed helpers exist only in the test entrypoint.
function fixtureMethods(Base: typeof RateLimiter) {
  return class Fixture extends Base {
    async seedFixture(): Promise<void> {
      await this.ctx.storage.put('sentinel', { body: 'synthetic preserved state', revision: 7 });
      this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS fixture_history (id INTEGER PRIMARY KEY, body TEXT)');
      this.ctx.storage.sql.exec("INSERT OR IGNORE INTO fixture_history VALUES(1, 'synthetic preserved history')");
    }

    async readFixture(): Promise<string> {
      return JSON.stringify({
        sentinel: await this.ctx.storage.get('sentinel'),
        history: this.ctx.storage.sql.exec('SELECT * FROM fixture_history').toArray(),
        alarm: await this.ctx.storage.getAlarm(),
      });
    }

    async scheduleFixtureAlarm(at: number): Promise<void> {
      await this.ctx.storage.setAlarm(at);
    }

    override fetch(request?: Request): Response {
      if (request && new URL(request.url).pathname === '/__fixture/socket') {
        const pair = new WebSocketPair();
        this.ctx.acceptWebSocket(pair[1]);
        return new Response(null, { status: 101, webSocket: pair[0] });
      }
      return super.fetch();
    }
  };
}

export class RateLimiterFixture extends fixtureMethods(RateLimiter) {}
export class WorkspaceHubFixture extends fixtureMethods(WorkspaceHub) {}
export default app;
