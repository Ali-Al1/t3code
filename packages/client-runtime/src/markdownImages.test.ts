import { describe, expect, it } from "vite-plus/test";

import { classifyMarkdownImageSource } from "./markdownImages.js";

describe("classifyMarkdownImageSource", () => {
  it.each([
    ["images/result.png", "/workspace/project", "/workspace/project/images/result.png"],
    [
      "images\\result.png",
      "C:\\Users\\dara\\project",
      "C:\\Users\\dara\\project\\images\\result.png",
    ],
    ["file:///workspace/project/image%20one.png", null, "/workspace/project/image one.png"],
    ["file://server/share/image.png", "\\\\server\\share", "\\\\server\\share\\image.png"],
  ])("maps %s to a workspace file", (source, workspaceRoot, path) => {
    expect(classifyMarkdownImageSource(source, workspaceRoot)).toEqual({
      _tag: "WorkspaceFile",
      path,
    });
  });

  it.each(["image.png", "javascript:alert(1)", "file://%"])(
    "blocks unsupported or unresolved source %s",
    (source) => {
      expect(classifyMarkdownImageSource(source)).toEqual({ _tag: "Blocked" });
    },
  );

  // Loading these makes Windows send the user's NTLM credentials to the named host.
  it.each([
    "file://attacker.test/share/cat.jpg",
    "\\\\attacker.test\\share\\cat.jpg",
    "/\\attacker.test\\share\\cat.jpg",
    "file:/%5Cattacker.test%5Cshare%5Ccat.jpg",
    "\\\\server\\other\\cat.jpg",
  ])("blocks network path %s outside the project", (source) => {
    expect(classifyMarkdownImageSource(source, "\\\\server\\share\\project")).toEqual({
      _tag: "Blocked",
    });
  });

  // An agent in Git Bash spells the drive `/c/...`; only a Windows project root says which
  // file it names, because Windows would read the authored spelling as a `c` directory.
  it("reads a Git Bash drive image as the Windows path it names for a Windows project", () => {
    expect(
      classifyMarkdownImageSource(
        "/c/Users/dara/project/images/result.png",
        "C:/Users/dara/project",
      ),
    ).toEqual({
      _tag: "WorkspaceFile",
      path: "C:/Users/dara/project/images/result.png",
    });
    expect(
      classifyMarkdownImageSource(
        "file:///c/Users/dara/project/images/result.png",
        "C:/Users/dara/project",
      ),
    ).toEqual({
      _tag: "WorkspaceFile",
      path: "C:/Users/dara/project/images/result.png",
    });
    expect(
      classifyMarkdownImageSource("/c/Users/dara/project/images/result.png", "/home/dara/project"),
    ).toEqual({
      _tag: "WorkspaceFile",
      path: "/c/Users/dara/project/images/result.png",
    });
    expect(classifyMarkdownImageSource("/c/Users/dara/project/images/result.png")).toEqual({
      _tag: "WorkspaceFile",
      path: "/c/Users/dara/project/images/result.png",
    });
  });
});
