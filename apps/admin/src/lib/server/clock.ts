/** "Now" for server-rendered pages. A named function (not an inline Date.now()) so pages stay readable and tests can stub it. */
export const serverNow = (): number => Date.now();
