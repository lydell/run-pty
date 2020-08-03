declare module "cross-spawn/lib/parse" {
  declare function parse(
    command: string,
    args: Array<string>,
    options: { [key: string]: never }
  ): { command: string; args: Array<string> };
  export = parse;
}
