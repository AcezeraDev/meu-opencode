import { describe, expect, test } from "bun:test"
import { BrowserSite } from "@/browser/site"

const click = (role: string, name: string) => BrowserSite.describeStep({ action: "click" }, { role, name })

/** A quiz the way Moodle runs it: start, answer, finish, submit, confirm. */
const quiz = (answer: string) => [
  click("button", "Tentar responder o questionário agora"),
  click("radio", answer),
  click("button", "Finalizar tentativa ..."),
  click("button", "Enviar tudo e terminar"),
  click("button", "Enviar tudo e terminar"),
]

describe("a routine done by hand", () => {
  test("is found when its first steps come round again, then grows while the rest matches the first time", () => {
    const session = `ses_routine_${Date.now()}`
    const host = "moodle.test"
    const seen = [...quiz("Monopólio legítimo da força"), click("link", "3. Construindo o conceito")].map((step) =>
      BrowserSite.observe(session, host, [step]),
    )
    expect(seen.every((item) => item === undefined)).toBe(true)

    // The second quiz picks another answer, which is not what makes it the same routine.
    const second = quiz("Os cidadãos").map((step) => BrowserSite.observe(session, host, [step]))
    expect(second.slice(0, 2)).toEqual([undefined, undefined])
    const texts = (steps: readonly BrowserSite.TrailStep[]) => steps.map((step) => step.text)
    expect(second[2]?.fresh).toBe(true)
    expect(texts(second[2]!.steps)).toEqual(texts(quiz("x").slice(0, 3)))
    expect(second[4]?.fresh).toBe(false)
    expect(texts(second[4]!.steps)).toEqual(texts(quiz("x")))

    // The drafted program takes the answer from args and finds the rest by name.
    const code = BrowserSite.draft(second[4]!.steps)
    expect(code).toContain('{ action: "click", answer: 0, role: "radio", label: "click radio (an answer)" },')
    expect(code).toContain('{ action: "click", name: "Enviar tudo e terminar", role: "button", label: ')
    expect(code).not.toContain("Os cidadãos")
  })

  test("starts where the agent went to an address, which the program then takes as args.url", () => {
    const session = `ses_open_${Date.now()}`
    const host = "moodle.test"
    const round = (id: number) => [
      BrowserSite.describeOpen(`https://${host}/mod/resource/view.php?id=${id}`),
      click("button", "Marcar como feito"),
      BrowserSite.describeOpen(`https://${host}/mod/quiz/view.php?id=${id + 1}`),
      ...quiz("A resposta"),
    ]
    const seen = [...round(101), ...round(103)].map((step) => BrowserSite.observe(session, host, [step]))
    const found = seen.filter((item) => item !== undefined)
    // Never the resource and the quiz as one routine: the quiz's address starts its own.
    expect(found.every((item) => item.steps.slice(1).every((step) => step.action))).toBe(true)
    const last = found.at(-1)!
    expect(last.steps[0]!.text).toBe("open /mod/quiz/view.php")
    expect(BrowserSite.draft(last.steps).split("\n")).toContain(
      "if (args.url) await tools.page.navigate({ url: args.url })",
    )
  })

  test("one step over and over is not a routine", () => {
    const session = `ses_loop_${Date.now()}`
    const next = click("link", "Próxima")
    const seen = Array.from({ length: 10 }, () => BrowserSite.observe(session, "moodle.test", [next]))
    expect(seen.every((item) => item === undefined)).toBe(true)
  })
})
