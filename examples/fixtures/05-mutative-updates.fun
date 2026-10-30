# Fixture 05: Mutative Deep Spreads and Local Drafts

export schema Profile = {
  name: String
  address: {
    city: String
    zip: String
  }
  tags: Array<String>
}

export updateCity = (p: Profile, newCity: String) ->
  {
    ...p
    address.city: newCity
  }

export appendTag = (p: Profile, tag: String) ->
  p
  |> mut (draft) ->
    draft.tags.push(tag)
    draft
