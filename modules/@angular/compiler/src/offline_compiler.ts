/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {SchemaMetadata} from '@angular/core';

import {CompileDirectiveMetadata, CompileIdentifierMetadata, CompileNgModuleMetadata, CompilePipeMetadata, CompileProviderMetadata, CompileTokenMetadata, StaticSymbol, createHostComponentMeta} from './compile_metadata';
import {DirectiveNormalizer} from './directive_normalizer';
import {ListWrapper} from './facade/collection';
import {Identifiers, resolveIdentifier, resolveIdentifierToken} from './identifiers';
import {CompileMetadataResolver} from './metadata_resolver';
import {NgModuleCompiler} from './ng_module_compiler';
import {OutputEmitter} from './output/abstract_emitter';
import * as o from './output/output_ast';
import {CompiledStylesheet, StyleCompiler} from './style_compiler';
import {TemplateParser} from './template_parser/template_parser';
import {ComponentFactoryDependency, ViewCompileResult, ViewCompiler, ViewFactoryDependency} from './view_compiler/view_compiler';

export class SourceModule {
  constructor(public moduleUrl: string, public source: string) {}
}

export class NgModulesSummary {
  constructor(public ngModuleByComponent: Map<StaticSymbol, CompileNgModuleMetadata>) {}
}

export class OfflineCompiler {
  constructor(
      private _metadataResolver: CompileMetadataResolver,
      private _directiveNormalizer: DirectiveNormalizer, private _templateParser: TemplateParser,
      private _styleCompiler: StyleCompiler, private _viewCompiler: ViewCompiler,
      private _ngModuleCompiler: NgModuleCompiler, private _outputEmitter: OutputEmitter,
      private _localeId: string, private _translationFormat: string) {}

  analyzeModules(ngModules: StaticSymbol[]): NgModulesSummary {
    const ngModuleByComponent = new Map<StaticSymbol, CompileNgModuleMetadata>();

    ngModules.forEach((ngModule) => {
      const ngModuleMeta = this._metadataResolver.getNgModuleMetadata(<any>ngModule);
      ngModuleMeta.declaredDirectives.forEach((dirMeta) => {
        if (dirMeta.isComponent) {
          ngModuleByComponent.set(dirMeta.type.reference, ngModuleMeta);
        }
      });
    });
    return new NgModulesSummary(ngModuleByComponent);
  }

  clearCache() {
    this._directiveNormalizer.clearCache();
    this._metadataResolver.clearCache();
  }

  compile(
      moduleUrl: string, ngModulesSummary: NgModulesSummary, components: StaticSymbol[],
      ngModules: StaticSymbol[]): Promise<SourceModule[]> {
    let fileSuffix = _splitTypescriptSuffix(moduleUrl)[1];
    let statements: o.Statement[] = [];
    let exportedVars: string[] = [];
    let outputSourceModules: SourceModule[] = [];

    // compile all ng modules
    exportedVars.push(
        ...ngModules.map((ngModuleType) => this._compileModule(ngModuleType, statements)));

    // compile components
    return Promise
        .all(components.map((compType) => {
          const compMeta = this._metadataResolver.getDirectiveMetadata(<any>compType);
          const ngModule = ngModulesSummary.ngModuleByComponent.get(compType);
          if (!ngModule) {
            throw new Error(`Cannot determine the module for component ${compMeta.type.name}!`);
          }
          return Promise
              .all([compMeta, ...ngModule.transitiveModule.directives].map(
                  dirMeta => this._directiveNormalizer.normalizeDirective(dirMeta).asyncResult))
              .then((normalizedCompWithDirectives) => {
                const compMeta = normalizedCompWithDirectives[0];
                const dirMetas = normalizedCompWithDirectives.slice(1);
                _assertComponent(compMeta);

                // compile styles
                const stylesCompileResults = this._styleCompiler.compileComponent(compMeta);
                stylesCompileResults.externalStylesheets.forEach((compiledStyleSheet) => {
                  outputSourceModules.push(this._codgenStyles(compiledStyleSheet, fileSuffix));
                });

                // compile components
                exportedVars.push(this._compileComponentFactory(compMeta, fileSuffix, statements));
                exportedVars.push(this._compileComponent(
                    compMeta, dirMetas, ngModule.transitiveModule.pipes, ngModule.schemas,
                    stylesCompileResults.componentStylesheet, fileSuffix, statements));
              });
        }))
        .then(() => {
          if (statements.length > 0) {
            outputSourceModules.unshift(this._codegenSourceModule(
                _ngfactoryModuleUrl(moduleUrl), statements, exportedVars));
          }
          return outputSourceModules;
        });
  }

  private _compileModule(ngModuleType: StaticSymbol, targetStatements: o.Statement[]): string {
    const ngModule = this._metadataResolver.getNgModuleMetadata(<any>ngModuleType);
    let appCompileResult = this._ngModuleCompiler.compile(ngModule, [
      new CompileProviderMetadata(
          {token: resolveIdentifierToken(Identifiers.LOCALE_ID), useValue: this._localeId}),
      new CompileProviderMetadata({
        token: resolveIdentifierToken(Identifiers.TRANSLATIONS_FORMAT),
        useValue: this._translationFormat
      })
    ]);
    appCompileResult.dependencies.forEach((dep) => {
      dep.placeholder.name = _componentFactoryName(dep.comp);
      dep.placeholder.moduleUrl = _ngfactoryModuleUrl(dep.comp.moduleUrl);
    });
    targetStatements.push(...appCompileResult.statements);
    return appCompileResult.ngModuleFactoryVar;
  }

  private _compileComponentFactory(
      compMeta: CompileDirectiveMetadata, fileSuffix: string,
      targetStatements: o.Statement[]): string {
    var hostMeta = createHostComponentMeta(compMeta);
    var hostViewFactoryVar =
        this._compileComponent(hostMeta, [compMeta], [], [], null, fileSuffix, targetStatements);
    var compFactoryVar = _componentFactoryName(compMeta.type);
    targetStatements.push(
        o.variable(compFactoryVar)
            .set(o.importExpr(resolveIdentifier(Identifiers.ComponentFactory), [o.importType(
                                                                                   compMeta.type)])
                     .instantiate(
                         [
                           o.literal(compMeta.selector), o.variable(hostViewFactoryVar),
                           o.importExpr(compMeta.type)
                         ],
                         o.importType(
                             resolveIdentifier(Identifiers.ComponentFactory),
                             [o.importType(compMeta.type)], [o.TypeModifier.Const])))
            .toDeclStmt(null, [o.StmtModifier.Final]));
    return compFactoryVar;
  }

  private _compileComponent(
      compMeta: CompileDirectiveMetadata, directives: CompileDirectiveMetadata[],
      pipes: CompilePipeMetadata[], schemas: SchemaMetadata[], componentStyles: CompiledStylesheet,
      fileSuffix: string, targetStatements: o.Statement[]): string {
    var parsedTemplate = this._templateParser.parse(
        compMeta, compMeta.template.template, directives, pipes, schemas, compMeta.type.name);
    var stylesExpr = componentStyles ? o.variable(componentStyles.stylesVar) : o.literalArr([]);
    var viewResult =
        this._viewCompiler.compileComponent(compMeta, parsedTemplate, stylesExpr, pipes);
    if (componentStyles) {
      ListWrapper.addAll(targetStatements, _resolveStyleStatements(componentStyles, fileSuffix));
    }
    ListWrapper.addAll(targetStatements, _resolveViewStatements(viewResult));
    return viewResult.viewFactoryVar;
  }

  private _codgenStyles(stylesCompileResult: CompiledStylesheet, fileSuffix: string): SourceModule {
    _resolveStyleStatements(stylesCompileResult, fileSuffix);
    return this._codegenSourceModule(
        _stylesModuleUrl(
            stylesCompileResult.meta.moduleUrl, stylesCompileResult.isShimmed, fileSuffix),
        stylesCompileResult.statements, [stylesCompileResult.stylesVar]);
  }

  private _codegenSourceModule(
      moduleUrl: string, statements: o.Statement[], exportedVars: string[]): SourceModule {
    return new SourceModule(
        moduleUrl, this._outputEmitter.emitStatements(moduleUrl, statements, exportedVars));
  }
}

function _resolveViewStatements(compileResult: ViewCompileResult): o.Statement[] {
  compileResult.dependencies.forEach((dep) => {
    if (dep instanceof ViewFactoryDependency) {
      let vfd = <ViewFactoryDependency>dep;
      vfd.placeholder.moduleUrl = _ngfactoryModuleUrl(vfd.comp.moduleUrl);
    } else if (dep instanceof ComponentFactoryDependency) {
      let cfd = <ComponentFactoryDependency>dep;
      cfd.placeholder.name = _componentFactoryName(cfd.comp);
      cfd.placeholder.moduleUrl = _ngfactoryModuleUrl(cfd.comp.moduleUrl);
    }
  });
  return compileResult.statements;
}


function _resolveStyleStatements(
    compileResult: CompiledStylesheet, fileSuffix: string): o.Statement[] {
  compileResult.dependencies.forEach((dep) => {
    dep.valuePlaceholder.moduleUrl = _stylesModuleUrl(dep.moduleUrl, dep.isShimmed, fileSuffix);
  });
  return compileResult.statements;
}

function _ngfactoryModuleUrl(compUrl: string): string {
  var urlWithSuffix = _splitTypescriptSuffix(compUrl);
  return `${urlWithSuffix[0]}.ngfactory${urlWithSuffix[1]}`;
}

function _componentFactoryName(comp: CompileIdentifierMetadata): string {
  return `${comp.name}NgFactory`;
}

function _stylesModuleUrl(stylesheetUrl: string, shim: boolean, suffix: string): string {
  return shim ? `${stylesheetUrl}.shim${suffix}` : `${stylesheetUrl}${suffix}`;
}

function _assertComponent(meta: CompileDirectiveMetadata) {
  if (!meta.isComponent) {
    throw new Error(`Could not compile '${meta.type.name}' because it is not a component.`);
  }
}

function _splitTypescriptSuffix(path: string): string[] {
  if (/\.d\.ts$/.test(path)) {
    return [path.substring(0, path.length - 5), '.ts'];
  }
  let lastDot = path.lastIndexOf('.');
  if (lastDot !== -1) {
    return [path.substring(0, lastDot), path.substring(lastDot)];
  } else {
    return [path, ''];
  }
}
