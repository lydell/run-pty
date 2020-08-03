declare module "cross-spawn/lib/parse" {
  declare function parse(
    file: string,
    args: Array<string>,
    options: { [key: string]: never }
  ): { file: string; args: Array<string> };
  export = parse;
}
