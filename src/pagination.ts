/**
 * Cursor pagination (`GET /v1/jobs`, `GET /v1/batches`).
 * @module
 */

/**
 * One page of a list. Iterate it with `for await` to walk through **all** items of every
 * following page (pages are fetched lazily, one request each):
 *
 * ```ts
 * const page = await wbx.jobs.list({ limit: 50 });
 * page.items;                     // the first 50
 * for await (const job of page) { // all of them, page by page
 *   console.log(job.id, job.status);
 * }
 * ```
 */
export class Page<T> implements AsyncIterable<T> {
  /** Items of this page. */
  readonly items: T[];
  /** Cursor of the next page, `undefined` on the last page. */
  readonly nextCursor: string | undefined;
  private readonly fetchPage: (cursor: string) => Promise<Page<T>>;

  /** Not meant to be called directly – use the {@link WBX} client. */
  constructor(items: T[], nextCursor: string | undefined, fetchPage: (cursor: string) => Promise<Page<T>>) {
    this.items = items;
    this.nextCursor = nextCursor || undefined;
    this.fetchPage = fetchPage;
  }

  /** Whether another page follows. */
  hasNextPage(): boolean {
    return this.nextCursor !== undefined;
  }

  /** Fetches the next page, or returns `undefined` on the last page. */
  async getNextPage(): Promise<Page<T> | undefined> {
    return this.nextCursor === undefined ? undefined : this.fetchPage(this.nextCursor);
  }

  /** Yields the items of this page and of all following pages. */
  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    let page: Page<T> | undefined = this;
    while (page) {
      yield* page.items;
      page = await page.getNextPage();
    }
  }
}
