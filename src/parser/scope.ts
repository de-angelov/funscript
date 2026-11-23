export interface ParserScope {
  mutableVariables: Set<string>;
  mutDraftVariables: Set<string>;
}

export class ScopeStack {
  private scopes: ParserScope[];

  constructor() {
    this.scopes = [
      {
        mutableVariables: new Set<string>(),
        mutDraftVariables: new Set<string>(),
      },
    ];
  }

  public reset(): void {
    this.scopes = [
      {
        mutableVariables: new Set<string>(),
        mutDraftVariables: new Set<string>(),
      },
    ];
  }

  public currentScope(): ParserScope {
    return this.scopes[this.scopes.length - 1];
  }

  public enterScope(): void {
    this.scopes.push({
      mutableVariables: new Set<string>(),
      mutDraftVariables: new Set<string>(),
    });
  }

  public exitScope(): void {
    if (this.scopes.length > 1) {
      this.scopes.pop();
    }
  }

  public addMutableVariable(name: string): void {
    this.currentScope().mutableVariables.add(name);
  }

  public addMutDraftVariable(name: string): void {
    this.currentScope().mutDraftVariables.add(name);
  }

  public isMutableVariable(name: string): boolean {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].mutableVariables.has(name)) {
        return true;
      }
    }
    return false;
  }

  public isMutDraftVariable(name: string): boolean {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].mutDraftVariables.has(name)) {
        return true;
      }
    }
    return false;
  }
}
