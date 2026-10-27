# Fixture 05: Mutative Deep Spreads and Local Drafts

export schema Profile = {
  name: string
  address: {
    city: string
    zip: string
  }
  tags: Array<string>
}

export updateCity = (p: Profile, newCity: string) ->
  {
    ...p
    address.city: newCity
  }

export appendTag = (p: Profile, tag: string) ->
  p
  |> mut (draft) ->
    draft.tags.push(tag)
    draft
