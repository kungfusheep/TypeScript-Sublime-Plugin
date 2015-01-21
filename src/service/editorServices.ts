/// <reference path='../../node_modules/typescript/bin/typescript.d.ts'/>
/// <reference path='../../node_modules/typescript/bin/typescript_internal.d.ts'/>
/// <reference path='node.d.ts' />

import ts = require('typescript');
import child_process=require('child_process');

var lineCollectionCapacity = 4;
var indentStrings: string[] = [];
var indentBase = "    ";
function getIndent(indentAmt: number) {
    if (!indentStrings[indentAmt]) {
        indentStrings[indentAmt] = "";
        for (var i = 0; i < indentAmt; i++) {
            indentStrings[indentAmt] += indentBase;
        }
    }
    return indentStrings[indentAmt];
}

export function printLine(s: string) {
    ts.sys.write(s + '\n'); 
}

function showLines(s: string) {
    var strBuilder = "";
    for (var i = 0, len = s.length; i < len; i++) {
        if (s.charCodeAt(i) == 10) {
            strBuilder += '\\n';
        }
        else if (s.charCodeAt(i) == 13) {
            strBuilder += '\\r';
        }
        else {
            strBuilder += s.charAt(i);
        }
    }
    return strBuilder;
}

export class ScriptInfo {
    svc: ScriptVersionCache;
    isRoot=false;
    children:ScriptInfo[]=[];
    activeProject: Project; // project to use by default for file
    homeProject: Project;   // project from associated tsconfig

    constructor(public filename: string, public content:string, public isOpen = true) {
        this.svc = ScriptVersionCache.fromString(content);
    }

    addChild(childInfo:ScriptInfo) {
        this.children.push(childInfo);
    }
    
    public snap() {
        return this.svc.getSnapshot();
    }

    public editContent(minChar: number, limChar: number, newText: string): void {
        this.svc.edit(minChar, limChar - minChar, newText);
    }

    public getTextChangeRangeBetweenVersions(startVersion: number, endVersion: number): ts.TextChangeRange {
        return this.svc.getTextChangesBetweenVersions(startVersion, endVersion);
    }

    getChangeRange(oldSnapshot: ts.IScriptSnapshot): ts.TextChangeRange {
        return this.snap().getChangeRange(oldSnapshot);
    }
}

export class CancellationToken {
    public static None = new CancellationToken();

    requestPending=false;

    constructor() {
    }

    cancel() {
        this.requestPending=true;
    }

    reset() {
        this.requestPending=false;
    }

    public isCancellationRequested() {
        var temp=this.requestPending;
        return temp;
    }
}

// TODO: make this a parameter of the service or in service environment

var defaultLibDir=
    "/home/steve/src/TypeScript-Service/node_modules/typescript/bin/lib.d.ts";

export class LSHost implements ts.LanguageServiceHost {
    private ls: ts.LanguageService = null;
    logger: ts.Logger;
    compilationSettings: ts.CompilerOptions;
    filenameToScript: ts.Map<ScriptInfo> = {};

    constructor(private cancellationToken: CancellationToken = CancellationToken.None) {
        this.logger = this;
        this.addDefaultLibrary();
    }

    trace(str:string) {
    }

    error(str:string) {
    }

    public cancel() {
        this.cancellationToken.cancel();
    }

    public reset() {
        this.cancellationToken.reset();
    }

    public addDefaultLibrary() {
        this.addFile(defaultLibDir);
    }

    getScriptSnapshot(filename: string): ts.IScriptSnapshot {
        return this.getScriptInfo(filename).snap();
    }

    setCompilationSettings(opt:ts.CompilerOptions) {
        this.compilationSettings=opt;
    }

    getCompilationSettings() {
        // change this to return active project settings for file
        return this.compilationSettings;
    }

    getScriptFileNames() {
        var filenames:string[]=[];
        for (var filename in this.filenameToScript) {
            filenames.push(filename);
        }
        return filenames;
    }

    getScriptVersion(filename: string) {
        return this.getScriptInfo(filename).svc.latestVersion().toString();
    }

    public getCancellationToken(): ts.CancellationToken {
        return this.cancellationToken;
    }

    public getCurrentDirectory(): string {
        return "";
    }

    public getDefaultLibFilename(): string {
        return "";
    }

    getScriptIsOpen(filename: string) {
        return this.getScriptInfo(filename).isOpen;
    }

    public addFile(name: string) {
        var content = ts.sys.readFile(name);
        this.addScript(name, content);
    }

    getScriptInfo(filename: string): ScriptInfo {
        return ts.lookUp(this.filenameToScript,filename);
    }

    public addScriptInfo(info:ScriptInfo) {
        if (!this.getScriptInfo(info.filename)) {
            this.filenameToScript[info.filename]=info;
            return info;
        }
    }

    public addScript(filename: string, content: string) {
        var script = new ScriptInfo(filename, content);
        this.filenameToScript[filename]=script;
        return script;
    }

    public saveTo(filename: string, tmpfilename: string) {
        var script = this.getScriptInfo(filename);
        if (script) {
            var snap=script.snap();
            ts.sys.writeFile(tmpfilename,snap.getText(0,snap.getLength()));
        }
    }

    public reloadScript(filename: string, tmpfilename: string, cb:()=>any) {
        var script = this.getScriptInfo(filename);
        if (script) {
            script.svc.reloadFromFile(tmpfilename,cb);
        }
    }

    public editScript(filename: string, minChar: number, limChar: number, newText: string) {
        var script = this.getScriptInfo(filename);
        if (script) {
            script.editContent(minChar, limChar, newText);
            return;
        }

        throw new Error("No script with name '" + filename + "'");
    }

    resolvePath(path: string): string {
        var start = new Date().getTime();
        var result = ts.sys.resolvePath(path);
        return result;
    }

    fileExists(path: string): boolean {
        var start = new Date().getTime();
        var result = ts.sys.fileExists(path);
        return result;
    }

    directoryExists(path: string): boolean {
        return ts.sys.directoryExists(path);
    }

    public log(s: string): void {
        // For debugging...
        //printLine("TypeScriptLS:" + s);
    }

    /**
     *  @param line 1 based index
     */
    lineToTextSpan(filename: string, line: number): ts.TextSpan {
        var script: ScriptInfo = this.filenameToScript[filename];
        var index=script.snap().index;

        var lineInfo=index.lineNumberToInfo(line+1);
        var len;
        if (lineInfo.leaf) {
            len = lineInfo.leaf.text.length;
        }
        else {
            var nextLineInfo=index.lineNumberToInfo(line+2);
            len=nextLineInfo.offset-lineInfo.offset;
        }
        return ts.createTextSpan(lineInfo.offset,len);
    }

    /**
     * @param line 1 based index
     * @param col 1 based index
     */
    lineColToPosition(filename: string, line: number, col: number): number {
        var script: ScriptInfo = this.filenameToScript[filename];
        var index=script.snap().index;

        var lineInfo=index.lineNumberToInfo(line);
        // TODO: assert this column is actually on the line
        return (lineInfo.offset + col - 1);
    }

    /**
     * @param line 0 based index
     * @param offset 0 based index
     */
    positionToZeroBasedLineCol(filename: string, position: number): ILineInfo {
        var script: ScriptInfo = this.filenameToScript[filename];
        var index=script.snap().index;
        var lineCol=index.charOffsetToLineNumberAndPos(position);
        return { line: lineCol.line - 1, offset: lineCol.offset };
    }
}

function getCanonicalFileName(filename: string) {
    if (ts.sys.useCaseSensitiveFileNames) {
        return filename;
    }
    else {
        return filename.toLowerCase();
    }
}

// assumes normalized paths
function getAbsolutePath(filename:string, directory: string) {
    var rootLength=ts.getRootLength(filename);
    if (rootLength>0) {
        return filename;
    }
    else {
        var splitFilename=filename.split('/');
        var splitDir=directory.split('/');
        var i=0;
        var dirTail=0;
        var sflen=splitFilename.length;
        while ((i<sflen) && (splitFilename[i].charAt(0)=='.')) {
            var dots=splitFilename[i];
            if (dots=='..') {
                dirTail++;
            }
            else if(dots!='.') {
                return undefined;
            }
            i++;
        }
        return splitDir.slice(0,splitDir.length-dirTail).concat(splitFilename.slice(i)).join('/');
    }
}

export interface ProjectFileOptions {
    // these fields can be present in the project file
    rootFiles?:string[];
    formatCodeOptions?: ts.FormatCodeOptions;
    commandLineOptions?: string;
}

export interface ProjectOptions extends ProjectFileOptions {
    compilerOptions?: ts.CompilerOptions;
}

export class Project {
    compilerService=new CompilerService();
    projectOptions:ProjectOptions;
    projectFilename:string;
    
    graphFinished() {
        this.compilerService.languageService.getNavigateToItems(".*");    
    }

    addGraph(scriptInfo:ScriptInfo) {
        if (this.addScript(scriptInfo)) {
            for (var i=0,clen=scriptInfo.children.length;i<clen;i++) {
                this.addGraph(scriptInfo.children[i]);
            }
        }
    }

    isExplicitProject() {
        return this.projectFilename;
    }

    addScript(info:ScriptInfo) {
        info.activeProject=this;
        return this.compilerService.host.addScriptInfo(info);
    }
    
    printFiles() {
        var filenames=this.compilerService.host.getScriptFileNames();
        filenames.map(filename=> { console.log(filename); });
    }

    setProjectOptions(projectOptions: ProjectOptions) {
        this.projectOptions=projectOptions;
        if (projectOptions.compilerOptions) {
            this.compilerService.setCompilerOptions(projectOptions.compilerOptions);
        }
        if (projectOptions.formatCodeOptions) {
            this.compilerService.setFormatCodeOptions(projectOptions.formatCodeOptions);
        }
        
    }

    static createProject(projectFilename: string) {
        var eproj=new Project();
        eproj.projectFilename=projectFilename;
        return eproj;
    }

    static createInferredProject(root: ScriptInfo) {
        var iproj=new Project();
        iproj.addGraph(root);
        iproj.graphFinished();

        return iproj;
    }
}

export interface ProjectOpenResult {
    success?: boolean;
    errorMsg?: string;
    project?: Project;
}

export class ProjectService {
    filenameToScriptInfo: ts.Map<ScriptInfo> = {};
    roots: ScriptInfo[]=[];
    inferredProjects:Project[]=[];
    rootsChanged=false;
    newRootDisjoint=true;
    lastRemovedRoots:ScriptInfo[]=[];

    getProjectForFile(filename: string) {
        var scriptInfo=ts.lookUp(this.filenameToScriptInfo,filename);
        if (!scriptInfo) {
            scriptInfo = this.openSpecifiedFile(filename);
        }
// TODO: error upon file not found
        return scriptInfo.activeProject;
    }

    printProjects() {
        for (var i=0,len=this.inferredProjects.length;i<len;i++) {
            var project=this.inferredProjects[i];
            console.log("Project "+i.toString());
            project.printFiles();
            console.log("-----------------------------------------------");
        }
    }

    removeRoot(info:ScriptInfo) {
        var len=this.roots.length;
        for (var i=0;i<len;i++) {
            if (this.roots[i]==info) {
                if (i<(len-1)) {
                    this.roots[i]=this.roots[len-1];
                }
                this.roots.length--;
                this.rootsChanged=true;
                info.isRoot=false;
                this.lastRemovedRoots.push(info);
                return true;
            }
        }
        return false;
    }

    openProjectFile(pfilename: string): ProjectOpenResult {
        pfilename=ts.normalizePath(pfilename);
        // file references will be relative to dirPath (or absolute)
        var dirPath = ts.getDirectoryPath(pfilename);
        var projectText=ts.sys.readFile(pfilename);
        var projectOptions=<ProjectOptions>JSON.parse(projectText);
        if (projectOptions.commandLineOptions) {
            var parsedCommandLine=ts.parseCommandLine(projectOptions.commandLineOptions.split(" "));
            if (parsedCommandLine.errors.length == 0) {
                projectOptions.compilerOptions = parsedCommandLine.options;
            }
            else {
                return { errorMsg: "syntax error in field 'command line options'" };
            }
        }
        if (projectOptions.rootFiles) {
            var proj=Project.createProject(pfilename);
            for (var i = 0, len = projectOptions.rootFiles.length; i < len; i++) {
                var rootFilename=projectOptions.rootFiles[i];
                var normRootFilename = ts.normalizePath(rootFilename);
                normRootFilename=getAbsolutePath(normRootFilename,dirPath);
                if (ts.sys.fileExists(normRootFilename)) {
                    var info = this.openFile(normRootFilename, true, true);
                    info.isRoot = true;
                    proj.addGraph(info);
                }
                else {
                    return { errorMsg: "specified root file " + rootFilename + " not found" };
                }
            }
            proj.setProjectOptions(projectOptions);
            return { success: true, project: proj };
        }
        else {
            return { errorMsg: "required field 'rootFiles' not found" };
        }
    }

    openSpecifiedFile(filename:string) {
        this.rootsChanged=false;
        this.lastRemovedRoots=[];
        this.newRootDisjoint=true;
        var info=this.openFile(filename,true);
        if (info && (this.rootsChanged)) {
            var i=0;
            var len=this.roots.length;
            if (this.newRootDisjoint) {
                i=len-1;
            }
            for (;i<len;i++) {
                var root=this.roots[i];
                root.isRoot=true;
                this.inferredProjects[i]=Project.createInferredProject(root);
            }
        }
        return info;
    }

    /**
     * @param filename is absolute pathname
     */
    openFile(filename: string,possibleRoot=false,explicitProject=false) {
        //console.log("opening "+filename+"...");
        filename=ts.normalizePath(filename);
        var dirPath = ts.getDirectoryPath(filename);
        //console.log("normalized as "+filename+" with dir path "+dirPath);
        var info = ts.lookUp(this.filenameToScriptInfo,filename);
        if (!info) {
            if (ts.sys.fileExists(filename)) {
                var content = ts.sys.readFile(filename);
                if (!content) {
                    content = "";
                }
                info = new ScriptInfo(filename, content);
                this.filenameToScriptInfo[filename] = info;
                if (possibleRoot && (!explicitProject)) {
                    this.roots.push(info);
                    this.rootsChanged = true;
                }
                if (content.length > 0) {
                    var preProcessedInfo = ts.preProcessFile(content, false); 
                    // TODO: add import references
                    if (preProcessedInfo.referencedFiles.length > 0) {
                        for (var i = 0, len = preProcessedInfo.referencedFiles.length; i < len; i++) {
                            var refFilename = ts.normalizePath(preProcessedInfo.referencedFiles[i].filename);
                            refFilename = getAbsolutePath(refFilename, dirPath);
                            var refInfo = this.openFile(refFilename);
                            if (refInfo) {
                                info.addChild(refInfo);
                            }

                        }
                    }
                }
            }
            else {
            }
        }

        if ((!explicitProject)&&(!possibleRoot)&&(info)&&(info.isRoot)&&(!info.activeProject.isExplicitProject())) {
            if (this.removeRoot(info)) {
                this.rootsChanged=true;
                this.newRootDisjoint=false;
            }
        }

        return info;
    }

}

export class CompilerService {
    cancellationToken = new CancellationToken();
    host = new LSHost(this.cancellationToken);
    languageService: ts.LanguageService;
    classifier: ts.Classifier;
    settings = ts.getDefaultCompilerOptions();
    documentRegistry = ts.createDocumentRegistry();
    formatCodeOptions: ts.FormatCodeOptions = CompilerService.defaultFormatCodeOptions;

    constructor() {
        this.host.setCompilationSettings(ts.getDefaultCompilerOptions());
        this.languageService = ts.createLanguageService(this.host, this.documentRegistry);
        this.classifier = ts.createClassifier(this.host);
    }

    setCompilerOptions(opt: ts.CompilerOptions) {
        this.host.setCompilationSettings(opt);
    }

    setFormatCodeOptions(fco: ts.FormatCodeOptions) {
        // use this loop to preserve default values
        for (var p in fco) {
            if ((<Object>fco).hasOwnProperty(p)) {
                this.formatCodeOptions[p]=fco[p];
            }
        }
    }

    isExternalModule(filename: string): boolean {
        var sourceFile = this.languageService.getSourceFile(filename);
        return ts.isExternalModule(sourceFile);
    }

    static defaultFormatCodeOptions: ts.FormatCodeOptions = {
        IndentSize: 4,
        TabSize: 4,
        NewLineCharacter: ts.sys.newLine,
        ConvertTabsToSpaces: true,
        InsertSpaceAfterCommaDelimiter: true,
        InsertSpaceAfterSemicolonInForStatements: true,
        InsertSpaceBeforeAndAfterBinaryOperators: true,
        InsertSpaceAfterKeywordsInControlFlowStatements: true,
        InsertSpaceAfterFunctionKeywordForAnonymousFunctions: false,
        InsertSpaceAfterOpeningAndBeforeClosingNonemptyParenthesis: false,
        PlaceOpenBraceOnNewLineForFunctions: false,
        PlaceOpenBraceOnNewLineForControlBlocks: false,
    }

}

export interface LineCollection {
    charCount(): number;
    lineCount(): number;
    isLeaf(): boolean;
    walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker): void;
    print(indentAmt: number): void;
}

export interface ILineInfo {
    line: number;
    offset: number;
    text?: string;
    leaf?: LineLeaf;
}

export enum CharRangeSection {
    PreStart,
    Start,
    Entire,
    Mid,
    End,
    PostEnd
}

export interface ILineIndexWalker {
    goSubtree: boolean;
    done: boolean;
    leaf(relativeStart: number, relativeLength: number, lineCollection: LineLeaf): void;
    pre? (relativeStart: number, relativeLength: number, lineCollection: LineCollection,
          parent: LineNode, nodeType: CharRangeSection): LineCollection;
    post? (relativeStart: number, relativeLength: number, lineCollection: LineCollection,
           parent: LineNode, nodeType: CharRangeSection): LineCollection;
}

class BaseLineIndexWalker implements ILineIndexWalker {
    goSubtree = true;
    done = false;
    leaf(rangeStart: number, rangeLength: number, ll: LineLeaf) {
    }
}

class EditWalker extends BaseLineIndexWalker {
    lineIndex = new LineIndex();
    // path to start of range
    startPath: LineCollection[];
    endBranch: LineCollection[] = [];
    branchNode: LineNode;
    // path to current node 
    stack: LineNode[];
    state = CharRangeSection.Entire;
    lineCollectionAtBranch: LineCollection;
    initialText = "";
    trailingText = ""; 
    suppressTrailingText = false;

    constructor() {
        super();
        this.lineIndex.root = new LineNode();
        this.startPath = [this.lineIndex.root];
        this.stack = [this.lineIndex.root];
    }

    insertLines(insertedText: string) {
        if (this.suppressTrailingText) {
            this.trailingText = "";
        }
        if (insertedText) {
            insertedText = this.initialText + insertedText + this.trailingText;
        }
        else {
            insertedText = this.initialText + this.trailingText;
        }
        var lm = LineIndex.linesFromText(insertedText);
        var lines = lm.lines;
        if (lines.length > 1) {
            if (lines[lines.length - 1] == "") {
                lines.length--;
            }
        }
        var branchParent: LineNode;
        var lastZeroCount: LineCollection;

        for (var k = this.endBranch.length-1; k >= 0; k--) {
            (<LineNode>this.endBranch[k]).updateCounts();
            if (this.endBranch[k].charCount() == 0) {
                lastZeroCount = this.endBranch[k];
                if (k > 0) {
                    branchParent = <LineNode>this.endBranch[k - 1];
                }
                else {
                    branchParent = this.branchNode;
                }
            }
        }
        if (lastZeroCount) {
            branchParent.remove(lastZeroCount);
        }

        // path at least length two (root and leaf)
        var insertionNode = <LineNode>this.startPath[this.startPath.length - 2];
        var leafNode = <LineLeaf>this.startPath[this.startPath.length - 1];
        var len = lines.length;

        if (len>0) {
            leafNode.text = lines[0];

            if (len > 1) {
                var insertedNodes = <LineCollection[]>new Array(len - 1);
                var startNode = <LineCollection>leafNode;
                for (var i = 1, len = lines.length; i < len; i++) {
                    insertedNodes[i - 1] = new LineLeaf(lines[i]);
                }
                var pathIndex = this.startPath.length - 2;
                while (pathIndex >= 0) {
                    insertionNode = <LineNode>this.startPath[pathIndex];
                    insertedNodes = insertionNode.insertAt(startNode, insertedNodes);
                    pathIndex--;
                    startNode = insertionNode;
                }
                var insertedNodesLen = insertedNodes.length;
                while (insertedNodesLen > 0) {
                    var newRoot = new LineNode();
                    newRoot.add(this.lineIndex.root);
                    insertedNodes = newRoot.insertAt(this.lineIndex.root, insertedNodes);
                    insertedNodesLen = insertedNodes.length;
                    this.lineIndex.root = newRoot;
                }
                this.lineIndex.root.updateCounts();
            }
            else {
                for (var j = this.startPath.length - 2; j >= 0; j--) {
                    (<LineNode>this.startPath[j]).updateCounts();
                }
            }
        }
        else {
            // no content for leaf node, so delete it
            insertionNode.remove(leafNode);
            for (var j = this.startPath.length - 2; j >= 0; j--) {
                (<LineNode>this.startPath[j]).updateCounts();
            }
        }

        return this.lineIndex;
    }

    post(relativeStart: number, relativeLength: number, lineCollection: LineCollection, parent: LineCollection, nodeType: CharRangeSection):LineCollection {
        // have visited the path for start of range, now looking for end
        // if range is on single line, we will never make this state transition
        if (lineCollection == this.lineCollectionAtBranch) {
            this.state = CharRangeSection.End;
        }
        // always pop stack because post only called when child has been visited
        this.stack.length--;
        return undefined;
    }

    pre(relativeStart: number, relativeLength: number, lineCollection: LineCollection, parent: LineCollection, nodeType: CharRangeSection) {
        // currentNode corresponds to parent, but in the new tree
        var currentNode = this.stack[this.stack.length - 1];

        if ((this.state == CharRangeSection.Entire) && (nodeType == CharRangeSection.Start)) {
            // if range is on single line, we will never make this state transition
            this.state = CharRangeSection.Start;
            this.branchNode = currentNode;
            this.lineCollectionAtBranch = lineCollection;
        }
        
        var child: LineCollection;
        function fresh(node: LineCollection): LineCollection {
            if (node.isLeaf()) {
                return new LineLeaf("");
            }
            else return new LineNode();
        }
        switch (nodeType) {
        case CharRangeSection.PreStart:
            this.goSubtree = false;
            if (this.state != CharRangeSection.End) {
                currentNode.add(lineCollection);
            }
            break;
        case CharRangeSection.Start:
            if (this.state == CharRangeSection.End) {
                this.goSubtree = false;
            }
            else {
                child = fresh(lineCollection);
                currentNode.add(child);
                this.startPath[this.startPath.length] = child;
            }
            break;
        case CharRangeSection.Entire:
            if (this.state != CharRangeSection.End) {
                child = fresh(lineCollection);
                currentNode.add(child);
                this.startPath[this.startPath.length] = child;
            }
            else {
                if (!lineCollection.isLeaf()) {
                    child = fresh(lineCollection);
                    currentNode.add(child);
                    this.endBranch[this.endBranch.length] = child;
                }
            }
            break;
        case CharRangeSection.Mid:
            this.goSubtree = false;
            break;
        case CharRangeSection.End:
            if (this.state != CharRangeSection.End) {
                this.goSubtree = false;
            }
            else {
                if (!lineCollection.isLeaf()) {
                    child = fresh(lineCollection);
                    currentNode.add(child);
                    this.endBranch[this.endBranch.length] = child;
                }
            }
            break;
        case CharRangeSection.PostEnd:
            this.goSubtree = false;
            if (this.state != CharRangeSection.Start) {
                currentNode.add(lineCollection);
            }
            break;
        }
        if (this.goSubtree) {
            this.stack[this.stack.length] = <LineNode>child;
        }
        return lineCollection;
    }
    // just gather text from the leaves
    leaf(relativeStart: number, relativeLength: number, ll: LineLeaf) {
        if (this.state == CharRangeSection.Start) {
            this.initialText = ll.text.substring(0, relativeStart);
        }
        else if (this.state == CharRangeSection.Entire) {
            this.initialText = ll.text.substring(0, relativeStart);
            this.trailingText = ll.text.substring(relativeStart+relativeLength);
        }
        else {
            // state is CharRangeSection.End
            this.trailingText = ll.text.substring(relativeStart + relativeLength);
        }
    }
}

// text change information 
export class TextChange {
    constructor(public pos: number, public deleteLen: number, public insertedText?: string) {
    }

    getTextChangeRange() {
        return ts.createTextChangeRange(ts.createTextSpan(this.pos, this.deleteLen),
                                        this.insertedText ? this.insertedText.length : 0);
    }
}

export class ScriptVersionCache {
    changes: TextChange[] = [];
    versions: LineIndexSnapshot[] = [];
    minVersion = 0;  // no versions earlier than min version will maintain change history
    private currentVersion = 0;

    static changeNumberThreshold = 8;
    static changeLengthThreshold = 256;

    // REVIEW: can optimize by coalescing simple edits
    edit(pos: number, deleteLen: number, insertedText?: string) {
        this.changes[this.changes.length] = new TextChange(pos, deleteLen, insertedText);
        if ((this.changes.length > ScriptVersionCache.changeNumberThreshold) ||
            (deleteLen > ScriptVersionCache.changeLengthThreshold) ||
            (insertedText && (insertedText.length>ScriptVersionCache.changeLengthThreshold))) {
            this.getSnapshot();
        }
    }

    latest() {
        return this.versions[this.currentVersion];
    }

    latestVersion() {
        if (this.changes.length > 0) {
            this.getSnapshot();
        }
        return this.currentVersion;
    }

    reloadFromFile(filename: string,cb?:()=>any) {
        var content = ts.sys.readFile(filename);
        this.reload(content);
        if (cb)
            cb();
    }
    
    // reload whole script, leaving no change history behind reload
    reload(script: string) {
        this.currentVersion++;
        this.changes=[]; // history wiped out by reload
        var snap = new LineIndexSnapshot(this.currentVersion, this);
        this.versions[this.currentVersion] = snap;
        snap.index = new LineIndex();
        var lm = LineIndex.linesFromText(script);
        snap.index.load(lm.lines);
        // REVIEW: could use linked list 
        for (var i = this.minVersion; i < this.currentVersion; i++) {
            this.versions[i]=undefined;
        }
        this.minVersion=this.currentVersion;

    }

    getSnapshot() {
        var snap = this.versions[this.currentVersion];
        if (this.changes.length > 0) {
            var snapIndex = this.latest().index;
            for (var i = 0, len = this.changes.length; i < len; i++) {
                var change = this.changes[i];
                snapIndex = snapIndex.edit(change.pos, change.deleteLen, change.insertedText);
            }
            snap = new LineIndexSnapshot(this.currentVersion + 1, this);
            snap.index = snapIndex;
            snap.changesSincePreviousVersion = this.changes;
            this.currentVersion = snap.version;
            this.versions[snap.version] = snap;
            this.changes = [];
        }
        return snap;
    }

    getTextChangesBetweenVersions(oldVersion: number, newVersion: number) {
        if (oldVersion < newVersion) {
            if (oldVersion >= this.minVersion) {
                var textChangeRanges: ts.TextChangeRange[] = [];
                for (var i = oldVersion + 1; i <= newVersion; i++) {
                    var snap = this.versions[i];
                    for (var j = 0, len = snap.changesSincePreviousVersion.length; j < len; j++) {
                        var textChange = snap.changesSincePreviousVersion[j];
                        textChangeRanges[textChangeRanges.length] = textChange.getTextChangeRange();
                    }
                }
                return ts.collapseTextChangeRangesAcrossMultipleVersions(textChangeRanges);
            }
            else {
                return undefined;
            }
        }
        else {
            return ts.unchangedTextChangeRange;
        }
    }

    static fromString(script: string) {
        var svc = new ScriptVersionCache();
        var snap = new LineIndexSnapshot(0, svc);
        svc.versions[svc.currentVersion] = snap;
        snap.index = new LineIndex();
        var lm = LineIndex.linesFromText(script);
        snap.index.load(lm.lines);
        return svc;
    }
}

export class LineIndexSnapshot implements ts.IScriptSnapshot {
    index: LineIndex;
    changesSincePreviousVersion: TextChange[] = [];

    constructor(public version: number, public cache: ScriptVersionCache) {
    }

    getText(rangeStart: number, rangeEnd: number) {
        return this.index.getText(rangeStart, rangeEnd-rangeStart);
    }

    getLength() {
        return this.index.root.charCount();
    }

    // this requires linear space so don't hold on to these 
    getLineStartPositions(): number[] {
        var starts: number[] = [-1];
        var count = 1;
        var pos = 0;
        this.index.every((ll, s, len) => {
            starts[count++] = pos;
            pos += ll.text.length;
            return true;
        },0);
        return starts;
    }

    getLineMapper() {
        return ((line: number) => {
            return this.index.lineNumberToInfo(line).offset;
        });
    }

    getTextChangeRangeSinceVersion(scriptVersion: number) {
        if (this.version <= scriptVersion) {
            return ts.unchangedTextChangeRange;
        }
        else {
            return this.cache.getTextChangesBetweenVersions(scriptVersion,this.version);
        }
    }

    getChangeRange(oldSnapshot: ts.IScriptSnapshot): ts.TextChangeRange {
        var oldSnap=<LineIndexSnapshot>oldSnapshot;
        return this.getTextChangeRangeSinceVersion(oldSnap.version);
    }
}


export class LineIndex {
    root: LineNode;
    // set this to true to check each edit for accuracy
    checkEdits=false;

    charOffsetToLineNumberAndPos(charOffset: number) {
        return this.root.charOffsetToLineNumberAndPos(1, charOffset);
    }

    lineNumberToInfo(lineNumber: number): ILineInfo {
        var lineCount = this.root.lineCount();
        if (lineNumber <= lineCount) {
            var lineInfo = this.root.lineNumberToInfo(lineNumber, 0);
            lineInfo.line = lineNumber;
            return lineInfo;
        }
        else {
            return {
                line: lineNumber,
                offset: this.root.charCount()
            }
        }
    }

    print() {
        printLine("index TC " + this.root.charCount() + " TL " + this.root.lineCount());
        this.root.print(0);
        printLine("");
    }

    load(lines: string[]) {
        var leaves: LineLeaf[] = [];
        for (var i = 0, len = lines.length; i < len; i++) {
            leaves[i] = new LineLeaf(lines[i]);
        }
        this.root = LineIndex.buildTreeFromBottom(leaves);
    }

    walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker) {
        this.root.walk(rangeStart, rangeLength, walkFns);
    }

    getText(rangeStart: number, rangeLength: number) {
        var accum = "";
        this.walk(rangeStart, rangeLength, {
            goSubtree: true,
            done: false,
            leaf: (relativeStart: number, relativeLength: number, ll: LineLeaf) => {
                accum = accum.concat(ll.text.substring(relativeStart,relativeStart+relativeLength));
            }
        });
        return accum;
    }

    every(f: (ll: LineLeaf, s: number, len: number) => boolean, rangeStart: number, rangeEnd?: number) {
        if (!rangeEnd) {
            rangeEnd = this.root.charCount();
        }
        var walkFns = {
            goSubtree: true,
            done: false,
            leaf: function (relativeStart: number, relativeLength: number, ll: LineLeaf) {
                if (!f(ll, relativeStart, relativeLength)) {
                    this.done = true;
                }
            }
        }
        this.walk(rangeStart, rangeEnd - rangeStart, walkFns);
        return !walkFns.done;
    }

    edit(pos: number, deleteLength:number, newText?: string) {
        function editFlat(source: string, s: number, dl: number, nt="") {
            return source.substring(0, s) + nt + source.substring(s + dl, source.length);
        }
        if (this.checkEdits) {
            var checkText=editFlat(this.getText(0,this.root.charCount()),pos,deleteLength,newText);
        }
        var walker = new EditWalker();
        if (deleteLength > 0) {
            // check whether last characters deleted are line break
            var e = pos + deleteLength;
            var lineInfo = this.charOffsetToLineNumberAndPos(e);
            if ((lineInfo && (lineInfo.offset == 0))) {
                // move range end just past line that will merge with previous line
                deleteLength += lineInfo.text.length;
                // store text by appending to end of insertedText
                if (newText) {
                    newText = newText + lineInfo.text;
                }
                else {
                    newText = lineInfo.text;
                }
            }
        }
        else if (pos >= this.root.charCount()) {
            // insert at end
            var endString = this.getText(pos - 1, 1);
            if (newText) {
                newText = endString + newText;
            }
            else {
                newText = endString;
            }
            pos = pos - 1;
            deleteLength = 0;
            walker.suppressTrailingText = true;
        }
        this.root.walk(pos, deleteLength, walker);
        walker.insertLines(newText);
        if (this.checkEdits) {
            var updatedText=this.getText(0,this.root.charCount());
            if (checkText != updatedText) {
                console.log("buffer edit mismatch");
            }
        }
        return walker.lineIndex;
    }

    static buildTreeFromBottom(nodes: LineCollection[]) : LineNode {
        var nodeCount = Math.ceil(nodes.length / lineCollectionCapacity);
        var interiorNodes: LineNode[] = [];
        var nodeIndex = 0;
        for (var i = 0; i < nodeCount; i++) {
            interiorNodes[i] = new LineNode();
            var charCount = 0;
            var lineCount = 0;
            for (var j = 0; j < lineCollectionCapacity; j++) {
                if (nodeIndex < nodes.length) {
                    interiorNodes[i].add(nodes[nodeIndex]);
                    charCount += nodes[nodeIndex].charCount();
                    lineCount += nodes[nodeIndex].lineCount();
                }
                else {
                    break;
                }
                nodeIndex++;
            }
            interiorNodes[i].totalChars = charCount;
            interiorNodes[i].totalLines = lineCount;
        }
        if (interiorNodes.length == 1) {
            return interiorNodes[0];
        }
        else {
            return this.buildTreeFromBottom(interiorNodes);
        }
    }

    static linesFromText(text: string) {
        var sourceSnap = ts.ScriptSnapshot.fromString(text);
        var lineStarts = sourceSnap.getLineStartPositions();

        if (lineStarts.length == 0) {
            return { lines: <string[]>[], lineMap: lineStarts };
        }
        var lines = <string[]>new Array(lineStarts.length);
        var lc = lineStarts.length - 1;
        for (var lmi = 0; lmi < lc; lmi++) {
            lines[lmi] = text.substring(lineStarts[lmi], lineStarts[lmi + 1]);
        }

        var endText = text.substring(lineStarts[lc]);
        if (endText.length > 0) {
            lines[lc] = endText;
        }
        else {
            lines.length--;
        }
        return { lines: lines, lineMap: lineStarts };
    }
}

export class LineNode implements LineCollection {
    totalChars = 0;
    totalLines = 0;
    children: LineCollection[] = [];

    isLeaf() {
        return false;
    }

    print(indentAmt: number) {
        var strBuilder = getIndent(indentAmt);
        strBuilder += ("node ch " + this.children.length + " TC " + this.totalChars + " TL " + this.totalLines + " :");
        printLine(strBuilder);
        for (var ch = 0, clen = this.children.length; ch < clen; ch++) {
            this.children[ch].print(indentAmt + 1);
        }
    }

    updateCounts() {
        this.totalChars = 0;
        this.totalLines = 0;
        for (var i = 0, len = this.children.length; i<len ; i++) {
            var child = this.children[i];
            this.totalChars += child.charCount();
            this.totalLines += child.lineCount();
        }
    }

    execWalk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker, childIndex: number, nodeType:CharRangeSection) {
        if (walkFns.pre) {
            walkFns.pre(rangeStart, rangeLength,this.children[childIndex], this, nodeType);
        }
        if (walkFns.goSubtree) {
            this.children[childIndex].walk(rangeStart, rangeLength, walkFns);
            if (walkFns.post) {
                walkFns.post(rangeStart, rangeLength, this.children[childIndex], this, nodeType);
            }
        }
        else {
            walkFns.goSubtree = true;
        }
        return walkFns.done;
    }

    skipChild(relativeStart: number, relativeLength: number, childIndex: number, walkFns: ILineIndexWalker, nodeType: CharRangeSection) {
        if (walkFns.pre && (!walkFns.done)) {
            walkFns.pre(relativeStart, relativeLength, this.children[childIndex], this, nodeType);
            walkFns.goSubtree = true;
        }
    }

    walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker) {
        // assume (rangeStart < this.totalChars) && (rangeLength <= this.totalChars) 
        var childIndex = 0;
        var child = this.children[0];
        var childCharCount = child.charCount();
        // find sub-tree containing start
        var adjustedStart = rangeStart;
        while (adjustedStart >= childCharCount) {
            this.skipChild(adjustedStart, rangeLength, childIndex, walkFns, CharRangeSection.PreStart);
            adjustedStart -= childCharCount;
            child = this.children[++childIndex];
            childCharCount = child.charCount();
        }
        // Case I: both start and end of range in same subtree
        if ((adjustedStart + rangeLength) <= childCharCount) {
            if (this.execWalk(adjustedStart, rangeLength, walkFns, childIndex, CharRangeSection.Entire)) {
                return;
            }
        }
        else {
            // Case II: start and end of range in different subtrees (possibly with subtrees in the middle)
            if (this.execWalk(adjustedStart, childCharCount - adjustedStart, walkFns, childIndex, CharRangeSection.Start)) {
                return;
            }
            var adjustedLength = rangeLength - (childCharCount - adjustedStart);
            child = this.children[++childIndex];
            if (!child) {
                this.print(2);
            }
            childCharCount = child.charCount();
            while (adjustedLength > childCharCount) {
                if (this.execWalk(0, childCharCount, walkFns, childIndex, CharRangeSection.Mid)) {
                    return;
                }
                adjustedLength -= childCharCount;
                child = this.children[++childIndex];
                childCharCount = child.charCount();
            }
            if (adjustedLength > 0) {
                if (this.execWalk(0, adjustedLength, walkFns, childIndex, CharRangeSection.End)) {
                    return;
                }
            }
        }
        // Process any subtrees after the one containing range end
        if (walkFns.pre) {
            var clen = this.children.length;
            if (childIndex < (clen - 1)) {
                for (var ej = childIndex+1; ej < clen; ej++) {
                    this.skipChild(0, 0, ej, walkFns, CharRangeSection.PostEnd);
                }
            }
        }
    }

    charOffsetToLineNumberAndPos(lineNumber: number, charOffset: number): ILineInfo {
        var childInfo = this.childFromCharOffset(lineNumber, charOffset);
        if (childInfo.childIndex<this.children.length) {
            if (childInfo.child.isLeaf()) {
                return {
                    line: childInfo.lineNumber,
                    offset: childInfo.charOffset,
                    text: (<LineLeaf>(childInfo.child)).text,
                    leaf: (<LineLeaf>(childInfo.child))
                };
            }
            else {
                var lineNode = <LineNode>(childInfo.child);
                return lineNode.charOffsetToLineNumberAndPos(childInfo.lineNumber, childInfo.charOffset);
            }
        }
        else {
            var lineInfo=this.lineNumberToInfo(this.lineCount(),0);
            return { line: this.lineCount(), offset: lineInfo.leaf.charCount() };
        }
    }

    lineNumberToInfo(lineNumber: number, charOffset: number): ILineInfo {
        var childInfo = this.childFromLineNumber(lineNumber, charOffset);
        if (childInfo.child.isLeaf()) {
            return {
                line: lineNumber,
                offset: childInfo.charOffset,
                text: (<LineLeaf>(childInfo.child)).text,
                leaf: (<LineLeaf>(childInfo.child))
            }
        }
        else {
            var lineNode = <LineNode>(childInfo.child);
            return lineNode.lineNumberToInfo(childInfo.relativeLineNumber, childInfo.charOffset);
        }
    }

    childFromLineNumber(lineNumber: number, charOffset: number) {
        var child: LineCollection;
        var relativeLineNumber = lineNumber;
        for (var i = 0, len = this.children.length; i < len; i++) {
            child = this.children[i];
            var childLineCount = child.lineCount();
            if (childLineCount >= relativeLineNumber) {
                break;
            }
            else {
                relativeLineNumber -= childLineCount;
                charOffset += child.charCount();
            }
        }
        return {
            child: child,
            childIndex: i,
            relativeLineNumber: relativeLineNumber,
            charOffset: charOffset
        };
    }

    childFromCharOffset(lineNumber: number, charOffset: number) {
        var child: LineCollection;
        for (var i = 0, len = this.children.length; i < len; i++) {
            child = this.children[i];
            if (child.charCount() > charOffset) {
                break;
            }
            else {
                charOffset -= child.charCount();
                lineNumber += child.lineCount();
            }
        }
        return {
            child: child,
            childIndex: i,
            charOffset: charOffset,
            lineNumber: lineNumber
        }
    }

    splitAfter(childIndex: number) {
        var splitNode: LineNode;
        var clen = this.children.length;
        childIndex++;
        var endLength = childIndex;
        if (childIndex < clen) {
            splitNode = new LineNode();
            while (childIndex < clen) {
                splitNode.add(this.children[childIndex++]);
            }
            splitNode.updateCounts();
        }
        this.children.length = endLength;
        return splitNode;
    }

    remove(child: LineCollection) {
        var childIndex = this.findChildIndex(child);
        var clen = this.children.length;
        if (childIndex < (clen - 1)) {
            for (var i = childIndex; i < (clen-1); i++) {
                this.children[i] = this.children[i + 1];
            }
        }
        this.children.length--;
    }

    findChildIndex(child: LineCollection) {
        var childIndex = 0;
        var clen = this.children.length;
        while ((this.children[childIndex] != child) && (childIndex < clen)) childIndex++;
        return childIndex;
    }

    insertAt(child: LineCollection, nodes: LineCollection[]) {
        var childIndex = this.findChildIndex(child);
        var clen = this.children.length;
        var nodeCount = nodes.length;
        // if child is last and there is more room and only one node to place, place it
        if ((clen < lineCollectionCapacity) && (childIndex == (clen - 1)) && (nodeCount == 1)) {
            this.add(nodes[0]);
            this.updateCounts();
            return [];
        }
        else {
            var shiftNode = this.splitAfter(childIndex);
            var nodeIndex = 0;
            childIndex++;
            while ((childIndex < lineCollectionCapacity) &&( nodeIndex<nodeCount)) {
                this.children[childIndex++] = nodes[nodeIndex++];
            }
            var splitNodes: LineNode[] = [];
            var splitNodeCount = 0;
            if (nodeIndex < nodeCount) {
                splitNodeCount = Math.ceil((nodeCount-nodeIndex) / lineCollectionCapacity);
                splitNodes = <LineNode[]>new Array(splitNodeCount);
                var splitNodeIndex = 0;
                for (var i = 0; i < splitNodeCount; i++) {
                    splitNodes[i] = new LineNode();
                }
                var splitNode = <LineNode>splitNodes[0];
                while (nodeIndex < nodeCount) {
                    splitNode.add(nodes[nodeIndex++]);
                    if (splitNode.children.length == lineCollectionCapacity) {
                        splitNodeIndex++;
                        splitNode = <LineNode>splitNodes[splitNodeIndex];
                    }
                }
                for (i = splitNodes.length - 1; i >= 0; i--) {
                    if (splitNodes[i].children.length == 0) {
                        splitNodes.length--;
                    }
                }
            }
            if (shiftNode) {
                splitNodes[splitNodes.length] = shiftNode;
            }
            this.updateCounts();
            for (i = 0; i < splitNodeCount; i++) {
                (<LineNode>splitNodes[i]).updateCounts();
            }
            return splitNodes;
        }
    }

    // assume there is room for the item; return true if more room
    add(collection: LineCollection) {
        this.children[this.children.length] = collection;
        return(this.children.length < lineCollectionCapacity);
    }

    charCount() {
        return this.totalChars;
    }

    lineCount() {
        return this.totalLines;
    }
}

export class LineLeaf implements LineCollection {
    udata: any;

    constructor(public text: string) {

    }

    setUdata(data: any) {
        this.udata = data;
    }

    getUdata() {
        return this.udata;
    }

    isLeaf() {
        return true;
    }

    walk(rangeStart: number, rangeLength: number, walkFns: ILineIndexWalker) {
        walkFns.leaf(rangeStart, rangeLength,  this);
    }

    charCount() {
        return this.text.length;
    }

    lineCount() {
        return 1;
    }

    print(indentAmt: number) {
        var strBuilder = getIndent(indentAmt);
        printLine(strBuilder + showLines(this.text));
    }
}

