fn supergraph_service(service) {
  let add_cookies_to_response = |response| {
    if response.context["set_cookie_headers"]?.len > 0 {
      response.headers["set-cookie"] = response.context["set_cookie_headers"];
    }
  };

  service.map_response(add_cookies_to_response);
}

fn subgraph_service(service, subgraph) {
  if subgraph == "conversion-api" {
    let forward_verified_subject = |request| {
      let claims = request.context["apollo::authentication::jwt_claims"];
      if claims != () && "sub" in claims {
        request.subgraph.headers["x-authenticated-sub"] = claims["sub"];
      }
    };

    service.map_request(forward_verified_subject);
    return;
  }

  if subgraph != "auth" {
    return;
  }

  let store_cookies_from_auth = |response| {
    if "set-cookie" in response.headers {
      if response.context["set_cookie_headers"] == () {
        response.context.set_cookie_headers = [];
      }

      response.context.set_cookie_headers += response.headers.values("set-cookie");
    }
  };

  service.map_response(store_cookies_from_auth);
}
