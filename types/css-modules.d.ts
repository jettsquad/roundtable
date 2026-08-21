/**
 * CSS Modules, as far as the typechecker is concerned.
 *
 * The build compiles `*.module.css` into a hashed class map and injects the
 * text. `string` rather than a generated per-file map: a generated map would
 * catch a typo'd class name, but it needs a codegen step that runs before
 * every typecheck, and the failure it prevents — `undefined` in a className —
 * is visible the first time the panel is opened.
 */
declare module "*.module.css" {
  const classes: Readonly<Record<string, string>>;
  export default classes;
}
