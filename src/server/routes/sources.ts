import {
  AddFilteredBody,
  AlertImportBody,
  BoardUrlBody,
  PortalsSaveBody,
  ScanBody,
} from "../../shared/schemas/api.ts";
import type { AppContext } from "../app-context.ts";
import { boardFromUrl, boardPageUrl } from "../discovery/ats.ts";
import { HttpError, Reply, type Router } from "../http/router.ts";
import { toJobDetail } from "./jobs.ts";

const humanize = (board: string) =>
  board
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

/** M5: the Sources screen: portals, scans, filtered postings and LinkedIn alert imports. */
export function sourceRoutes(router: Router, app: AppContext): void {
  router.get("/api/sources", () => app.discovery.view());

  router.put("/api/sources", async ({ body }) => {
    const { value, expectedSha256 } = await body(PortalsSaveBody);
    return app.discovery.savePortals(value, expectedSha256);
  });

  /** Turns a board or job link into a portal draft; nothing is fetched. */
  router.post("/api/sources/board-from-url", async ({ body }) => {
    const { url } = await body(BoardUrlBody);
    const board = boardFromUrl(url);
    if (!board) {
      throw new HttpError(
        400,
        "unknown-board",
        "That is not a Greenhouse, Lever or Ashby board. Paste the company's careers link on one of them.",
      );
    }
    return { ...board, company: humanize(board.board), page: boardPageUrl(board) };
  });

  router.post("/api/sources/scan", async ({ body }) => {
    const { portals } = await body(ScanBody);
    return new Reply(202, app.discovery.startScan("manual", portals));
  });

  router.post("/api/sources/add", async ({ body }) => {
    const { source, ref } = await body(AddFilteredBody);
    return new Reply(201, toJobDetail(await app.discovery.addFiltered(source, ref)));
  });

  router.post("/api/sources/linkedin", async ({ body }) => {
    const { text } = await body(AlertImportBody);
    return new Reply(202, app.discovery.startAlertImport(text));
  });
}
