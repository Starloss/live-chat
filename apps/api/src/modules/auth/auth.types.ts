export interface JwtPayload {
  sub: string;
  email: string;
  username: string;
  exp: number;
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  username: string;
}

export interface AuthUserDto {
  id: string;
  email: string;
  username: string;
}
