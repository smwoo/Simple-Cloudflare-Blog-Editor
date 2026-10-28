import { describe, it, expect, beforeEach } from 'vitest'
import { FakeD1 } from '../../sync/__tests__/fakeD1.js'
import { COMMENTS_SCHEMA_SQL, listComments, deleteComment, deletePostComments } from '../comments.js'

let d1: FakeD1
const add = (post: string, parent: number | null, name: string) =>
  d1.query(`INSERT INTO comments (post, parent_id, name, body, created_at) VALUES (?, ?, ?, 'x', 1)`, [
    post,
    parent,
    name,
  ])

beforeEach(async () => {
  d1 = new FakeD1()
  await d1.exec(COMMENTS_SCHEMA_SQL)
  await add('a', null, 'Bob') // 1
  await add('a', 1, 'Cy') // 2
  await add('a', null, 'Di') // 3
  await add('b', null, 'Ed') // 4
})

describe('comments, from the app', () => {
  it('lists one post’s comments in order', async () => {
    expect((await listComments(d1, 'a')).map((c) => [c.id, c.parent, c.name])).toEqual([
      [1, null, 'Bob'],
      [2, 1, 'Cy'],
      [3, null, 'Di'],
    ])
  })

  it('deleting a top comment takes its replies; a reply goes alone', async () => {
    expect(await deleteComment(d1, 1)).toBe(2)
    expect((await listComments(d1, 'a')).map((c) => c.name)).toEqual(['Di'])
    await add('a', 3, 'Fay')
    expect(await deleteComment(d1, 5)).toBe(1)
    expect((await listComments(d1, 'a')).map((c) => c.name)).toEqual(['Di'])
  })

  it('removing a post clears only its comments', async () => {
    await deletePostComments(d1, 'a')
    expect(await listComments(d1, 'a')).toEqual([])
    expect(await listComments(d1, 'b')).toHaveLength(1)
  })
})
