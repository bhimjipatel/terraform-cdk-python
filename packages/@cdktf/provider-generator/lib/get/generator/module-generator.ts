// Copyright (c) HashiCorp, Inc
// SPDX-License-Identifier: MPL-2.0
import { CodeMaker, toCamelCase } from "codemaker";
import { ConstructsMakerModuleTarget } from "../constructs-maker";
import { AttributeModel } from "./models";
import { sanitizedComment } from "./sanitized-comments";

export class ModuleGenerator {
  constructor(
    private readonly code: CodeMaker,
    private readonly targets: ConstructsMakerModuleTarget[]
  ) {
    this.code.indentation = 2;

    for (const target of this.targets) {
      this.emitSubmodule(target);
    }
  }

  private emitSubmodule(target: ConstructsMakerModuleTarget) {
    const spec = target.spec;

    if (!spec) {
      throw new Error(`missing spec for ${target.fqn}`);
    }

    this.code.openFile(target.fileName);

    this.code.line(`// generated by cdktf get`);
    this.code.line(`// ${target.source}`);

    this.code.line(
      `import { TerraformModule, TerraformModuleUserConfig } from 'cdktf';`
    );
    this.code.line(`import { Construct } from 'constructs';`);

    const baseName = this.code.toPascalCase(target.name.replace(/[-/.]/g, "_"));
    const configType = `${baseName}Config`;

    this.code.openBlock(
      `export interface ${configType} extends TerraformModuleUserConfig`
    );
    for (const input of spec.inputs) {
      const optional = input.required && input.default === undefined ? "" : "?";

      const comment = sanitizedComment(this.code);
      if (input.description) {
        comment.line(input.description);
      }
      if (input.default) {
        comment.line(input.default);
      }
      if (input.type.includes("map(")) {
        comment.line(
          `The property type contains a map, they have special handling, please see {@link cdk.tf/module-map-inputs the docs}`
        );
      }
      comment.end();

      this.code.line(
        `readonly ${AttributeModel.escapeName(
          toCamelCase(input.name)
        )}${optional}: ${parseType(input.type)};`
      );
    }
    this.code.closeBlock();

    // Add a link to the Terraform Registry if it is sourced from there
    // https://developer.hashicorp.com/terraform/language/modules/sources
    // Registry modules are referred to as <NAMESPACE>/<NAME>/<PROVIDER>
    // Other sources contain dots, e.g.
    // app.terraform.io/example-corp/k8s-cluster/azurerm (private registries)
    // github.com/hashicorp/example (Github)
    // git@github.com:hashicorp/example.git
    // bitbucket.org/hashicorp/terraform-consul-aws (Bitbucket)
    // ... and more
    // ../module and ./module (local paths)
    const isNonRegistryModule = target.source.includes(".");
    let registryPath;
    // Submodules also exist (e.g. terraform-aws-modules/vpc/aws//modules/vpc-endpoints)
    // And linking directly to them in the Registry requires including the version
    // like e.g. https://registry.terraform.io/modules/terraform-aws-modules/vpc/aws/latest/submodules/vpc-endpoints
    if (target.source.includes("//")) {
      registryPath = target.source.replace(
        "//modules",
        `/${target.version || "latest"}/submodules`
      );
      // terraform-aws-modules/vpc/aws//modules/vpc-endpoints
      // ->
      // terraform-aws-modules/vpc/aws/latest/submodules/vpc-endpoints
    } else {
      // not submodule specified, just append the version
      registryPath = `${target.source}/${target.version || "latest"}`;
    }

    const comment = sanitizedComment(this.code);
    comment.line(`Defines an ${baseName} based on a Terraform module`);
    comment.line(``);
    comment.line(
      isNonRegistryModule
        ? `Source at ${target.source}`
        : `Docs at Terraform Registry: {@link https://registry.terraform.io/modules/${registryPath} ${target.source}}`
    );
    comment.end();
    this.code.openBlock(`export class ${baseName} extends TerraformModule`);

    this.code.line(`private readonly inputs: { [name: string]: any } = { }`);

    const allOptional = spec.inputs.find((x) => x.required) ? "" : " = {}";

    this.code.open(
      `public constructor(scope: Construct, id: string, config: ${configType}${allOptional}) {`
    );
    this.code.open(`super(scope, id, {`);
    this.code.line("...config,");
    this.code.line(`source: '${target.source}',`);
    if (target.version) {
      this.code.line(`version: '${target.version}',`);
    }
    this.code.close(`});`);

    for (const input of spec.inputs) {
      const inputName = AttributeModel.escapeName(toCamelCase(input.name));
      this.code.line(`this.${inputName} = config.${inputName};`);
    }

    this.code.close(`}`); // ctor

    for (const input of spec.inputs) {
      const inputName = AttributeModel.escapeName(toCamelCase(input.name));
      const inputType =
        parseType(input.type) +
        (input.required && input.default === undefined ? "" : " | undefined");
      this.code.openBlock(`public get ${inputName}(): ${inputType}`);
      this.code.line(`return this.inputs['${input.name}'] as ${inputType};`);
      this.code.closeBlock();

      this.code.openBlock(`public set ${inputName}(value: ${inputType})`);
      this.code.line(`this.inputs['${input.name}'] = value;`);
      this.code.closeBlock();
    }

    for (const output of spec.outputs) {
      const outputName = toCamelCase(output.name);
      this.code.openBlock(`public get ${outputName}Output()`);
      this.code.line(`return this.getString('${output.name}')`);
      this.code.closeBlock();
    }

    this.code.openBlock(`protected synthesizeAttributes()`);
    this.code.line(`return this.inputs;`);
    this.code.closeBlock();

    this.code.closeBlock(); // class
    this.code.closeFile(target.fileName);
  }
}

function parseType(type: string) {
  if (type === "string") {
    return "string";
  }
  if (type === "number") {
    return "number";
  }
  if (type === "bool") {
    return "boolean";
  }
  if (type === "list") {
    return "string[]";
  }
  if (type === "map") {
    return "{ [key: string]: string }";
  }
  if (type === "tuple") {
    return "string[]";
  }
  if (type === "any") {
    return "any";
  }

  const complexType = parseComplexType(type);
  if (complexType) {
    return complexType;
  }

  throw new Error(`unknown type ${type}`);
}

function parseComplexType(type: string): string | undefined {
  const complex = /^(object|list|map|set|tuple)\(([\s\S]+)\)/;
  const match = complex.exec(type);
  if (!match) {
    return undefined;
  }

  const [, kind, innerType] = match;

  if (kind === "object") {
    return `any`;
  }

  if (kind === "list" || kind === "set") {
    return `${parseType(innerType)}[]`;
  }

  if (kind === "tuple") {
    return `any[]`;
  }

  if (kind === "map") {
    return `{ [key: string]: ${parseType(innerType)} }`;
  }

  throw new Error(`unexpected kind ${kind}`);
}