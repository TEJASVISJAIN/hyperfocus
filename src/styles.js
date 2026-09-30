// The few ANSI styles the focus view and recap use.
export const BOLD = '\x1b[1m';
export const DIM = '\x1b[2m';
export const GREEN = '\x1b[32m';
export const RED = '\x1b[31m';
export const YELLOW = '\x1b[33m';
export const BLUE = '\x1b[34m';
export const MAGENTA = '\x1b[35m';
export const CYAN = '\x1b[36m';
export const INVERSE = '\x1b[7m';
export const RESET = '\x1b[0m';
export const INDENT = '  ';

// https://no-color.org: a non-empty NO_COLOR turns colour off; bold, dim and inverse stay.
export const colorAllowed = (env = process.env) => !env.NO_COLOR && env.TERM !== 'dumb';
export const stripColor = (text) => text.replace(/\x1b\[3[0-9]m/g, '');
