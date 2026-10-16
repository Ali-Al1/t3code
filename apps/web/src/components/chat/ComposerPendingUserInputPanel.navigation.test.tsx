import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { act, useState, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import {
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../../pendingUserInput";

vi.mock("../ui/collapsible", () => {
  const Children = ({ children }: { children: ReactNode }) => <>{children}</>;
  return {
    Collapsible: Children,
    CollapsiblePanel: Children,
    CollapsibleTrigger: Children,
  };
});

vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => <p>{text}</p> }));

import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };

const prompt = {
  requestId: RuntimeRequestId.make("question-navigation"),
  createdAt: "2026-10-09T00:00:00.000Z",
  dismissible: false,
  responseCapability: "live" as const,
  questions: [0, 1, 2].map((index) => ({
    id: `question-${index}`,
    header: `Question ${index + 1}`,
    question: `Choose for question ${index + 1}`,
    options: [{ label: "Incremental", description: "One module at a time" }],
    multiSelect: false,
  })),
};

function Questions({ initialIndex = 0 }: { initialIndex?: number }) {
  const [questionIndex, setQuestionIndex] = useState(initialIndex);
  const [answers, setAnswers] = useState<Record<string, PendingUserInputDraftAnswer>>({});
  const advance = () => setQuestionIndex(questionIndex + 1);
  return (
    <>
      <output>{questionIndex}</output>
      <button onClick={advance}>Next</button>
      <button onClick={() => setQuestionIndex(questionIndex - 1)}>Previous</button>
      <ComposerPendingUserInputPanel
        pendingUserInputs={[prompt]}
        cwd="/repo"
        threadRef={threadRef}
        disabled={false}
        respondingRequestIds={[]}
        answers={answers}
        questionIndex={questionIndex}
        onAdvance={advance}
        onToggleOption={(questionId, value) => {
          const question = prompt.questions.find((entry) => entry.id === questionId)!;
          setAnswers((existing) => ({
            ...existing,
            [questionId]: togglePendingUserInputOptionSelection(
              question,
              existing[questionId],
              value,
            ),
          }));
        }}
        onDismiss={() => {}}
      />
    </>
  );
}

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
  });
  vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function chooseOption() {
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((button) =>
        button.findAllByType("span").some((span) => span.children.includes("Incremental")),
      )!
      .props.onClick();
  });
}

async function navigate(label: string) {
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((button) => button.children.includes(label))!
      .props.onClick();
  });
}

function activeIndex() {
  return renderer!.root.findByType("output").children.join("");
}

it("does not skip the next unanswered question after manual advance", async () => {
  await act(async () => {
    renderer = create(<Questions />);
  });
  await chooseOption();
  await navigate("Next");
  expect(activeIndex()).toBe("1");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");

  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("2");
});

it("does not undo previous-question navigation with a stale timer", async () => {
  await act(async () => {
    renderer = create(<Questions initialIndex={1} />);
  });
  await chooseOption();
  await navigate("Previous");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("0");
});

it("still auto-advances once after the answer draft rerenders the same question", async () => {
  await act(async () => {
    renderer = create(<Questions />);
  });
  await chooseOption();
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
  await act(async () => vi.advanceTimersByTime(200));
  expect(activeIndex()).toBe("1");
});

it("picks a fixed-choice option from a digit typed into an empty composer only", async () => {
  class FakeElement {
    constructor(readonly textContent: string) {}
    closest() {
      return this;
    }
  }
  vi.stubGlobal("HTMLElement", FakeElement);
  vi.stubGlobal("HTMLInputElement", class {});
  vi.stubGlobal("HTMLTextAreaElement", class {});
  const onToggleOption = vi.fn();
  await act(async () => {
    renderer = create(
      <ComposerPendingUserInputPanel
        pendingUserInputs={[
          {
            ...prompt,
            questions: [
              {
                id: "search",
                header: "Question 1",
                question: "Allow web search?",
                options: [
                  { label: "Allow", description: "Allow", value: "allow" },
                  { label: "Disable", description: "Disable", value: "disable" },
                ],
                multiSelect: false,
                allowCustomAnswer: false,
              },
            ],
          },
        ]}
        cwd="/repo"
        threadRef={threadRef}
        disabled={false}
        respondingRequestIds={[]}
        answers={{}}
        questionIndex={0}
        onAdvance={() => {}}
        onToggleOption={onToggleOption}
        onDismiss={() => {}}
      />,
    );
  });
  const keydown = vi
    .mocked(document.addEventListener)
    .mock.calls.findLast(([type]) => type === "keydown")![1] as (event: KeyboardEvent) => void;
  const press = async (composerText: string) => {
    const event = {
      key: "1",
      target: new FakeElement(composerText),
      preventDefault: vi.fn(),
    } as unknown as KeyboardEvent;
    await act(async () => keydown(event));
    return event;
  };

  const typedIntoMessage = await press("Just answer, no search 1");
  expect(typedIntoMessage.preventDefault).not.toHaveBeenCalled();
  expect(onToggleOption).not.toHaveBeenCalled();

  const pickedOption = await press("");
  expect(pickedOption.preventDefault).toHaveBeenCalled();
  expect(onToggleOption).toHaveBeenCalledWith("search", "allow");
});
