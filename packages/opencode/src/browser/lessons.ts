/**
 * The activities of the course open in the browser, read from Moodle's course
 * index (the drawer with the weeks), and whether each one is done. The person
 * picks the pending ones and the agent does them in a row, instead of opening
 * each lesson by its address one by one.
 *
 * Only reads the page: nothing is clicked or opened.
 */

export interface Lesson {
  name: string
  url: string
  /** Marked as done in the course: Moodle's completion is on and complete. */
  done: boolean
  /** The course tracks this one's completion; a page with only text does not. */
  tracked: boolean
  /** The kind of activity, from its address: assign, h5pactivity, url, quiz… */
  kind: string
}

export interface Section {
  /** Where it sits, as the index shows it: the week and, inside it, the lesson. */
  name: string
  lessons: Lesson[]
}

export interface Course {
  course: string
  url: string
  sections: Section[]
}

/**
 * Reads the course index. Moodle 4 nests sections (a week holding its
 * lessons), so each activity is placed under the section that holds it
 * directly, named with the one around it. A completion mark is
 * `.completioninfo[data-value]` (1 done, 0 not yet); the Boost Union theme
 * keeps a second copy of it inside the activity icon.
 */
export const READ = String.raw`(() => {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim()
  const titleOf = (section) => {
    const title = section && section.querySelector(":scope > .courseindex-section-title, :scope > div > .courseindex-section-title")
    const link = title && title.querySelector(".courseindex-link, a")
    return clean((link && (link.innerText || link.textContent)) || (title && title.innerText))
  }
  const sections = new Map()
  for (const item of document.querySelectorAll('.courseindex-item[data-for="cm"]')) {
    const link = item.querySelector("a.courseindex-link, a[href*='/mod/']")
    if (!link || !link.href) continue
    const section = item.closest(".courseindex-section")
    const outer = section && section.parentElement ? section.parentElement.closest(".courseindex-section") : null
    const name = [titleOf(outer), titleOf(section)].filter(Boolean).join(" › ")
    const values = [...item.querySelectorAll(".completioninfo")].map((mark) => mark.dataset.value).filter((value) => value === "0" || value === "1")
    const pictured = item.querySelector('img[alt="Feito"], img[title="Feito"], img[alt="Done"]')
    const kind = (link.href.match(/\/mod\/(\w+)\//) || [])[1] || ""
    const lesson = {
      name: clean(link.innerText || link.textContent),
      url: link.href,
      done: values.includes("1") || !!pictured,
      tracked: values.length > 0 || !!pictured,
      kind,
    }
    const list = sections.get(name)
    if (list) list.push(lesson)
    else sections.set(name, [lesson])
  }
  const heading = document.querySelector(".page-header-headings h1, #page-header h1, header h1")
  return {
    course: clean(heading && heading.innerText) || document.title,
    url: location.href,
    sections: [...sections.entries()].map(([name, lessons]) => ({ name, lessons })),
  }
})()`

export * as BrowserLessons from "./lessons"
